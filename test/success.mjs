/**
 * @license
 * Copyright 2023 Qlever LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import config from '../config.js';

import { setTimeout } from 'node:timers/promises';

import _ from 'lodash';
import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import debug from 'debug';
import moment from 'moment';

import oada from '@oada/client';

const info = debug('trellis-shares:test:info');

chai.use(chaiAsPromised);
const { expect } = chai;

let jobkey = false;
const jobpath = `/bookmarks/services/trellis-shares/jobs`;
const coiKey = 'TEST-COI5-DUMMY';

const tree = {
  bookmarks: {
    _type: 'application/vnd.oada.bookmarks.1+json',
    services: {
      '_type': 'application/vnd.oada.services.1+json',
      'trellis-shares': {
        _type: 'application/vnd.oada.service.1+json',
        jobs: {
          '_type': 'application/vnd.oada.jobs.1+json',
          '*': {
            _type: 'application/vnd.oada.job.1+json',
          },
        },
      },
    },
    trellisfw: {
      _type: 'application/vnd.trellis.1+json',
      cois: {
        '_type': 'application/vnd.trellis.cois.1+json',
        '*': {
          _type: 'application/vnd.trellis.coi.1+json',
        },
      },
    },
  },
};

let jobcfg = {};

process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0;
describe('success job', () => {
  let con = false;

  before(async function () {
    this.timeout(10_000);
    info('Before 1: started');
    const domain = config.get('domain').replace(/^https:\/\//, '');
    info('Before 2: connecting to oada');
    con = await oada.connect({ domain, token: config.get('token') });
    info('Before 3: connected.  Cleaning up as needed.');

    // ------------------------------------------
    // Do some cleanup: get rid of src, dest, fakeuser
    for await (const path of [
      `/resources/${coiKey}`,
      `/bookmarks/trellisfw/cois/${coiKey}`,
    ]) {
      try {
        await con.get({ path });

        // Delete it if it exists
        await con.delete({ path });
      } catch {
        // ignore if it doesn't
      }
    }

    // Create the dummy coi and link
    info('Before: creating dummy COI');
    await con.put({
      path: `/resources/${coiKey}`,
      headers: { 'content-type': 'application/vnd.trellis.coi.1+json' },
      data: {
        holder: {
          name: 'test name',
        },
      },
    });
    info('Before: linking dummy COI');
    await con.put({
      path: `/bookmarks/trellisfw/cois`,
      tree,
      data: {
        [coiKey]: { _id: `resources/${coiKey}`, _rev: 0 },
      },
    });

    info('Before: getting first trading partner to use as guinea pig');
    const tp = await con
      .get({ path: '/bookmarks/trellisfw/trading-partners' })
      .then((r) => _.find(_.keys(r.data), (k) => !k.startsWith('_')))
      .then((tpid) =>
        con.get({ path: `/bookmarks/trellisfw/trading-partners/${tpid}` })
      )
      .then((r) => r.data);
    info('Before: using trading-partner', tp);
    const tpkey = tp._id.replace(/^resources\//, '');

    jobcfg = {
      doctype: 'cois',
      src: `/bookmarks/trellisfw/cois/${coiKey}`,
      dest: `/bookmarks/trellisfw/cois/${coiKey}`,
      chroot: `/bookmarks/trellisfw/trading-partners/${tpkey}/user/bookmarks`,
      user: tp.user,
      tree,
    };

    info('Before: posting job to get job key');
    // --------------------------------------------------------
    // Example of a successful normal job: go ahead and put that up, tests will check results later
    jobkey = await con
      .post({
        path: `/resources`,
        headers: { 'content-type': 'application/vnd.oada.job.1+json' },
        data: {
          service: 'trellis-shares',
          type: 'share-user-link',
          config: jobcfg,
        },
      })
      .then((r) => r.headers['content-location'].replace(/^\/resources\//, ''));
    info('Before: job posted, key =', jobkey);

    // Link job under queue to start things off:
    info(`Before: linking job at ${jobpath}/${jobkey}`);
    await con.put({
      path: `${jobpath}/${jobkey}`,
      data: { _id: `resources/${jobkey}` },
    });
    info(`Before: job linked, waiting to for it to finish`);
    await setTimeout(1000);
    info('Before: finished, running tests');
  });

  // Now the real checks begin.  Did trellis-shares:
  // 1: dest exists
  // 2: dest._id is same src._id
  // 3: create abalonemail job with legit token for conductor

  it('should create the dest endpoint with same _id as src', async () => {
    const destpath = jobcfg.chroot.replace(/\/bookmarks$/, '') + jobcfg.dest;
    const { data: srcdata } = await con.get({ path: jobcfg.src });
    const { data: destdata } = await con.get({ path: destpath });
    expect(destdata._id).to.equal(srcdata._id);
  });

  it('should have status of success on the job when completed', async () => {
    const { data: result } = await con.get({
      path: `resources/${jobkey}/status`,
    });
    expect(result).to.equal('success');
  });

  it('should delete the job from jobs', async () => {
    const result = await con
      .get({ path: `${jobpath}/${jobkey}` })
      .catch((error) => error); // Returns the error
    expect(result.status).to.equal(404);
  });

  it("should put the job under today's day-index within jobs-success", async () => {
    const day = moment().format('YYYY-MM-DD');
    const { data: result } = await con.get({
      path: `/bookmarks/services/trellis-shares/jobs-success/day-index/${day}/${jobkey}`,
    });
    expect(result._id).to.equal(`resources/${jobkey}`);
  });
});
