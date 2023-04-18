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

// This is a CLI script
/* eslint-disable no-console, no-process-exit, unicorn/no-process-exit */

import { connect } from '@oada/client';

import config from '../config.js';
const jobpath = `/bookmarks/services/trellis-shares/jobs`;

const tree = {
  bookmarks: {
    _type: 'application/vnd.oada.bookmarks.1+json',
    services: {
      '_type': 'application/vnd.oada.services.1+json',
      'trellis-shares': {
        '_type': 'application/vnd.oada.service.1+json',
        'jobs': {
          '_type': 'application/vnd.oada.jobs.1+json',
          '*': {
            _type: 'application/vnd.oada.job.1+json',
          },
        },
        'jobs-success': {
          '_type': 'application/vnd.oada.jobs.1+json',
          '*': {
            _type: 'application/vnd.oada.job.1+json',
          },
        },
        'jobs-error': {
          '_type': 'application/vnd.oada.jobs.1+json',
          '*': {
            _type: 'application/vnd.oada.job.1+json',
          },
        },
      },
    },
  },
};

const domain = config.get('domain');
const con = await connect({ domain, token: config.get('token') });

const srckey = await con
  .post({
    path: '/resources',
    headers: { 'content-type': 'application/vnd.test.1+json' },
    data: {
      thisthing: 'is a test resource',
    },
  })
  .then((r) => r.headers['content-location'].replace(/^\/resources\//, ''));
await con.put({
  path: `/bookmarks/testfakeuserentry`,
  data: {
    bookmarks: {},
  },
});

// --------------------------------------------------------
// Example of a successful normal job: go ahead and put that up, tests will check results later
const jobkey = await con
  .post({
    path: `/resources`,
    headers: { 'content-type': 'application/vnd.oada.job.1+json' },
    data: {
      type: 'share-user-link',
      config: {
        src: { _id: `resources/${srckey}` },
        doctype: 'test',
        userdest: `/bookmarks/testthings/${srckey}`,
        userbookmarks: `/bookmarks/testfakeuserentry/bookmarks`,
      },
    },
  })
  .then((r) => r.headers['content-location'].replace(/^\/resources\//, ''));

// Link job under queue to start things off:
console.log('Creating job key:', jobkey);
await con.put({
  path: `${jobpath}`,
  headers: { 'content-type': 'application/vnd.oada.jobs.1+json' },
  tree,
  data: {
    [jobkey]: { _id: `resources/${jobkey}` },
  },
});

process.exit(0);
