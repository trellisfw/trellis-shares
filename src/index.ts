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

import config from './config.js';

import '@oada/pino-debug';
// TODO: Add prometheus metrics
import '@oada/lib-prom';

import { readFile } from 'node:fs/promises';

import addrs, { type ParsedMailbox } from 'email-addresses';
// FIXME: Don't use lodash
import _ from 'lodash';
import debug from 'debug';
import flatten from 'flat';
import jsonpointer from 'json-pointer';
import oError from '@overleaf/o-error';
import { v4 as uuidV4 } from 'uuid';

import ml from '@trellisfw/masklink';
// @ts-expect-error no types
import tsig from '@trellisfw/signatures';

import { type Job, Service } from '@oada/jobs';
import type Link from '@oada/types/oada/link/v1.js';
import type { OADAClient } from '@oada/client';

import makeAndPostMaskedPdf from './pdfgen.js';
// @ts-expect-error import nonsense
import template from '../email_templates/index.js';
import tree from './tree.js';

const error = debug('trellis-shares:error');
const warn = debug('trellis-shares:warn');
const info = debug('trellis-shares:info');
const trace = debug('trellis-shares:trace');

const token = config.get('oada.token');
let domain = config.get('oada.domain') || '';
if (domain.startsWith('http')) domain = domain.replace(/^https:\/\//, '');

if (domain === 'localhost' || domain === 'proxy') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const SKIN = config.get('email.skin');

// -------------------------------------------------
// Items for masking&signing:
// You can generate a signing key pair by running `oada-certs --create-keys`
const privateJWK = JSON.parse(
  `${await readFile(config.get('signing.privateJWK'))}`
);
const publicJWK = tsig.keys.pubFromPriv(privateJWK);
const header: { jwk: typeof publicJWK; jku?: string; kid?: string } = {
  jwk: publicJWK,
};
if (privateJWK.jku) header.jku = privateJWK.jku; // Make sure we keep jku and kid
if (privateJWK.kid) header.kid = privateJWK.kid;
const signer = config.get('signing.signer');

const service = new Service({
  name: 'trellis-shares',
  oada: { domain, token, concurrency: 1 },
  opts: {
    finishReporters: [
      {
        type: 'slack',
        status: 'failure',
        posturl: config.get('slack.posturl'),
      },
    ],
  },
}); // 1 concurrent job

// 5 min timeout
service.on(
  'share-user-link',
  config.get('timeout'),
  async (job, { jobId, oada }) => {
    trace(job, `Received job ${jobId}`);
    // Until oada-jobs adds cross-linking, make sure we are linked under pdf's jobs
    trace('Linking job under src/_meta until oada-jobs can do that natively');
    await oada.put({
      // @ts-expect-error
      path: `${job.config?.src}/_meta/services/trellis-shares/jobs`,
      data: {
        [jobId]: { _ref: `resources/${jobId}` },
      },
    });

    if (
      !(job.config && typeof job.config === 'object') ||
      Array.isArray(job.config)
    ) {
      throw new Error('Job has no config');
    }

    const {
      config: { dest, copy, versioned, tree, doctype },
    } = job as unknown as {
      config: {
        versioned?: boolean;
        dest: string;
        chroot?: string;
        doctype: 'fsqa-audits' | 'cois';
        copy?: { meta?: any; mask?: any; original: any };
        tree: any;
      };
    };

    // Find the net dest path, taking into consideration chroot
    let destpath = dest;
    let chroot = '';
    if ('chroot' in config) {
      chroot = job.config.chroot as string;
      chroot = chroot.replace(/\/$/, ''); // No trailing slash
      if (chroot.endsWith('/bookmarks')) {
        trace(
          'chroot exists and ends in bookmarks, getting rid of bookmarks part'
        );
        chroot = chroot.replace(/\/bookmarks$/, '');
      }

      destpath = `${chroot}${destpath}`;
      trace('Final destpath = %s', destpath);
    }

    // Get original so we can get ID, and create the srclink
    const { data: orig } = (await oada.get({
      path: job.config.src as string,
    })) as any;
    const srclink: Link = {
      _id: orig?._id,
    };
    let source = _.cloneDeep(orig); // Default is we're linking to original resource

    // Now, replace original and sourcelink if we are supposed to make a copy instead of just linking:
    if (copy) {
      // Make a copy, keeping all the common keys between job.copy.original and job.copy.meta
      let { data: meta } = (await oada.get({
        path: `${job.config.src}/_meta`,
      })) as { data: any };
      // Flatten() returns a flat object with path:value pairs like:
      // {
      //   "a.b.c": <value>
      //   "d.e": <value>
      // },
      // therefore, _.keys of that is all the paths from the object, regardless of value
      // _.pick will return an object with only the paths you pass.
      // Therefore, _.pick(_.keys(flatten())) will end up with an object only containing the
      // same paths as the "config" object.
      if (_.isObject(copy.meta)) {
        const meta_paths_to_keep = _.keys(flatten(copy.meta));
        trace(
          'Have a meta key-pick spec, meta_paths_to_keep = ',
          meta_paths_to_keep
        );
        trace('picking from meta = ', meta);
        meta = _.pick(meta, meta_paths_to_keep);
      }
      // Now we have the proper meta before the copy, add whatever is needed for mask or copy below, then
      // save final meta at the end

      // If masking is requested by the job, the mask library will make the new copy resource (still need to handle meta):
      let newId: string | undefined;
      if (copy.mask) {
        // This masked copy cannot link to an original unmasked pdf, so we need to remove it from meta,
        // but we should get it's original filename to re-use on the mask:
        let pdfFilename: string | undefined;
        if (meta.vdoc?.pdf) {
          // Hack: getting _meta/filename doesn't work, have to get entire _meta, then get filename from that
          pdfFilename = await oada
            .get({ path: `/${meta.vdoc.pdf._id}/_meta` })
            .then(
              (r) =>
                // @ts-expect-error
                r.data?.filename as string
            )
            .then((f) => `MASKED-${f}`)
            .catch(() => {
              warn(
                'Failed to get PDF filename from original at /%s/_meta/filename',
                meta.vdoc.pdf._id
              );
              // eslint-disable-next-line unicorn/no-useless-undefined
              return undefined;
            });
          // Delete the PDF link in the new copy's meta
          delete meta.vdoc.pdf;
        }

        // Note that maskAndSignRemoteResourceAsNewResource will create a new resource and put new stuff in its meta, but
        // we don't need to load it into our copy of meta because our eventual PUT to meta will just be merged with that.
        trace(
          'masked copy requested: awaiting maskAndSignRemoteResourceAsNewResource...'
        );
        newId = await ml.maskAndSignRemoteResourceAsNewResource({
          url: `https://${domain}/${orig._id}`,
          privateJWK,
          signer,
          token,
          paths: findPathsToMask(orig, copy.mask.keys_to_mask),
        });
        // Refresh src with newly masked JSON as the new resource:
        trace(`Refreshing src object with masked copy data`);
        source = await oada
          .get({ path: `/${newId}` })
          .then((r) => r.data)
          .catch((error_) => {
            error(
              { error: error_ },
              `Could not get newly masked resource at /${newId}`
            );
          });

        // Store a reference in the masked copy back to the original:
        meta.copy = { src: { _ref: newId }, masked: true };

        // Generate and link a PDF if necessary:
        if (copy.mask.generate_pdf) {
          trace('PDF copy of masked document requested');
          const pdfId = await makeAndPostMaskedPdf({
            masked: source,
            _id: newId,
            doctype,
            filename: pdfFilename ?? '',
            domain,
            token,
          });
          trace(
            "Created new PDF, linking under the masked copy's meta.vdoc.pdf to %s",
            pdfId
          );
          if (!meta.vdoc) {
            meta.vdoc = {};
          }

          meta.vdoc.pdf = { _id: pdfId };
          // The _meta will be put later, same for mask as for copy
        } else {
          trace(
            copy.mask,
            'Masked copy requested, but no PDF version asked to be generated'
          );
        }

        // Otherwise, just a simple copy operation is requested.  Perform the copy on the original resource, then
        // handle meta later the same for both the copy and the mask
      } else {
        trace('Copy requested instead of link, making copy');

        // Now get rid of any _ keys
        source = _.omitBy(source, (_v, k) => /^_/.exec(k));
        meta = _.omitBy(meta, (_v, k) => /^_/.exec(k));
        // Set the type same as original
        source._type = orig._type;

        // Note: omitting keys on a document with a signature will result in an invalid signature.  Use a mask in that case.
        if (_.isObject(copy.original)) {
          const orig_paths_to_keep = _.keys(flatten(copy.original));
          trace(
            'Have an original key-pick spec, orig_paths_to_keep = ',
            orig_paths_to_keep
          );
          source = _.pick(source, orig_paths_to_keep);
        }

        // Create the copy resource
        newId =
          (await oada
            .post({ path: `/resources`, data: source })
            .then((r) => r.headers['content-location']?.replace(/^\//, ''))) ??
          undefined;
      }

      // Add ref to original in the copy's _meta: (should we cross-link original->copy to all copies, or only copy->original?)
      meta.copy = { src: { _ref: orig._id } };
      trace('Created copy resource, new id = ', newId);
      // Put the new meta:
      trace(
        `Putting meta to /${newId}/_meta for masked = ${copy.mask}, data for meta is `,
        meta
      );
      await oada.put({ path: `/${newId}/_meta`, data: meta });

      // Reset the srclink to point to the copy now
      srclink._id = newId!;
      // Save the new id back to the job config so it can get returned with the result
      job.config.newid = newId;
    }

    // If we want a versioned link to the resource, set _rev on the link we're about to put:
    if (versioned) {
      srclink._rev = 0;
    }

    // Note that the tree is only from dest on down, and does not include the chroot,
    // so we have to implement our own tree put
    trace('primary put: path = %s, data = %O', destpath, srclink);
    await putLinkAndEnsureParent({
      path: destpath,
      data: srclink,
      chroot,
      tree,
      oada,
    });
    info(
      'Successfully linked src = %s to dest = %s with chroot %s',
      srclink,
      dest,
      chroot
    );

    trace('Incrementing share count under src/_meta');
    const shareCount = await oada
      .get({
        path: `${job.config.src}/_meta`,
      })
      .then((r) => r.data)
      .then((r: any) =>
        r &&
        r.services &&
        r.services['trellis-shares'] &&
        r.services['trellis-shares']['share-count']
          ? r.services['trellis-shares']['share-count']
          : 0
      )
      .catch((error_) => {
        if (!error_ || error_.status !== 404)
          throw oError.tag(
            error_,
            'Failed to fetch share count, non-404 error status returned'
          );
        return 0; // No share-count there, so it's just initialized to 0
      });
    trace(
      'Retrieved share-count = %s, PUTting new incremented count',
      shareCount
    );
    await oada.put({
      path: `${job.config.src}/_meta/services/trellis-shares`,
      data: { 'share-count': shareCount + 1 },
    });

    if (!job.config.skipCreatingEmailJobs) {
      // This flag is mainly for testing
      // HARDCODED UNTIL AINZ CAN DO THIS INSTEAD
      await createEmailJobs({ oada, job });
    }

    return job.config; // For lack of something better to put in the result...
  }
);

// Since we know the last key is a link key, treat it differently because if the
// link already exists, we don't want to put directly to that endpoint because it
// will write to the resource instead of the parent.
async function putLinkAndEnsureParent({
  path,
  data,
  chroot,
  tree,
  oada,
}: {
  path: string;
  data: any;
  chroot: string;
  tree: any;
  oada: OADAClient;
}) {
  const parts = jsonpointer.parse(path);
  const linkkey = parts[parts.length - 1];
  path = jsonpointer.compile(_.slice(parts, 0, parts.length - 1));
  trace('#putLinkAndEnsureParent: Bottom-level linkkey = %s', linkkey);
  data = { [linkkey!]: data };

  // Ensure the parent:
  const exists = await oada
    .get({ path })
    .then((r) => r.status)
    .catch((error_) => error_.status);
  trace(
    '#putLinkAndEnsureParent: After getting path %s, exists (status) = %s',
    path,
    exists
  );
  if (exists === 404) {
    // Parent does not exist, need to create a resource and link in it's parent
    trace(
      '#putLinkAndEnsureParent: Destination parent %s did not exist, creating...',
      path
    );
    const treeobj = jsonpointer.get(tree, path.replace(chroot, ''));
    if (!treeobj)
      throw new Error(
        `The specified path does not exist in tree after removing chroot.  Path = ${path.replace(
          chroot,
          ''
        )}`
      );
    const { _type } = treeobj;
    const { _rev } = treeobj;
    if (!_type)
      throw new Error(
        `Currently this chroot tree put does not allow non-resource parts of the tree and we have a part without a _type`
      );

    // Create a resource, put link into it's parent
    const newId = await oada
      .post({
        path: '/resources',
        contentType: _type,
        data: {},
      })
      .then((r) => r.headers['content-location']?.replace(/^\//, ''));
    trace(
      '#putLinkAndEnsureParent: posted new resource to /resources for the child, newId = %s',
      newId
    );

    const newlink: Link = { _id: newId! };
    if (_rev) {
      newlink._rev = 0; // If tree asked for versioned
    }

    trace(
      data,
      `#putLinkAndEnsureParent: recursively running now for path ${path}`
    );
    await putLinkAndEnsureParent({ path, data: newlink, chroot, tree, oada });
  }

  trace(
    data,
    `Destination parent ${path} now is known to exist, putting to path`
  );

  // If we get here, parent exists and we can put, no need for content-type
  return oada.put({ path, data }).then((r) => r.headers['content-location']);
}

async function createEmailJobs({ oada, job }: { oada: OADAClient; job: Job }) {
  const { config } = job as unknown as {
    config: { doctype: string; chroot?: string; user: { id: string } };
  };
  // We just linked a doctype into a user, lookup the trading partner id for
  // that user and use the doc type to figure out which email list
  const tpId = config.chroot?.replace(
    /^.*trading-partners\/([^/]+)\/.*$/,
    '$1'
  );
  trace('createEmailJobs: tpid = %s', tpId);

  const { doctype } = config;
  const usertoken = uuidV4().replace(/-/g, '');
  const d = {
    clientId: 'SERVICE-CLIENT-TRELLIS-SHARES',
    user: { _id: config.user.id },
    token: usertoken,
    scope: ['all:all'],
    createTime: Date.now(),
    expiresIn: 90 * 24 * 3600 * 1000, // 90 days, in milliseconds
  };

  trace(
    d,
    `createEmailJobs: posting to /authorizations for user ${config.user.id}`
  );
  const { data: auth } = await oada
    .post({
      path: '/authorizations',
      data: d,
      contentType: 'application/vnd.oada.authorization.1+json',
    })
    .catch((error_: unknown) => {
      info(
        error_,
        `FAILED to post to /authorizations for user ${config.user.id}`
      );
      throw error_;
    });
  trace(auth, 'createEmailJobs: auth post finished');
  let emails = '';
  let subject = '';
  switch (doctype) {
    case 'cois': {
      ({ data: emails } = (await oada.get({
        path: `/bookmarks/trellisfw/trading-partners/${tpId}/coi-emails`,
      })) as { data: string });
      subject = 'New certificate of insurance available';
      break;
    }

    case 'letters-of-guarantee': {
      ({ data: emails } = (await oada.get({
        path: `/bookmarks/trellisfw/trading-partners/${tpId}/coi-emails`,
      })) as { data: string });
      subject = 'New letter of guarantee available';
      break;
    }

    case 'fsqa-certificates': {
      ({ data: emails } = (await oada.get({
        path: `/bookmarks/trellisfw/trading-partners/${tpId}/fsqa-emails`,
      })) as { data: string });
      subject = 'New FSQA certificate available';
      break;
    }

    case 'fsqa-audits': {
      ({ data: emails } = (await oada.get({
        path: `/bookmarks/trellisfw/trading-partners/${tpId}/fsqa-emails`,
      })) as { data: string });
      subject = 'New FSQA Audit available';
      break;
    }

    default: {
      throw new Error(
        `ERROR: doctype ${doctype} is not recognized, no email job created`
      );
    }
  }

  const jobkey = await oada
    .post({
      path: '/resources',
      data: {
        service: 'abalonemail',
        type: 'email',
        config: {
          multiple: false,
          to: (
            addrs.parseAddressList(emails) as ParsedMailbox[]
          ).map<ParsedMailbox>(({ name, address }) => ({
            // @ts-expect-error
            name: name || undefined,
            email: address,
          })),
          from: 'info@dev.trellis.one',
          subject: `Trellis notification: ${subject}`,
          templateData: {
            recipients: emails,
            link: `https://trellisfw.github.io/conductor?d=${domain}&t=${usertoken}&s=${SKIN}`,
          },
          html: template.html,
          attachments: template.attachments,
        },
      } as any,
    })
    .then((r) => r.headers['content-location']?.replace(/^\/resources\//, ''));

  // Link into abalonemail queue
  await oada.put({
    path: `/bookmarks/services/abalonemail/jobs`,
    data: { [jobkey!]: { _id: `resources/${jobkey}` } },
    tree,
  });
  info('Posted email job for trading partner %s', tpId);
}

await service.start();

// ----------------------------------------------------------------------------------------
// Recursive function that returns a flat list of json-pointer paths to any matching keys
function findPathsToMask(
  object: Record<string, unknown>,
  keys_to_mask: readonly string[],
  previouspath = ''
): string[] {
  const jp = jsonpointer.parse(previouspath);
  return _.reduce(
    _.keys(object),
    (accumulator, k) => {
      const curpath = jsonpointer.compile([...jp, k]);
      if (_.includes(keys_to_mask, k)) {
        accumulator.push(curpath);
        return accumulator;
      }

      const value: unknown = object[k];
      if (value && typeof value === 'object') {
        // Recursively keep looking for paths
        return accumulator.concat(
          findPathsToMask(
            value as Record<string, unknown>,
            keys_to_mask,
            curpath
          )
        );
      }

      return accumulator;
    },
    [] as string[]
  );
}
