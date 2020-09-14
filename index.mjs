import { readFileSync } from 'fs'
import Promise from 'bluebird'
import _ from 'lodash'
import debug from 'debug'
import Jobs from '@oada/jobs'
import tree from './tree.js'
import jsonpointer from 'json-pointer'
import template from './email_templates/index.js'
import { v4 as uuidv4 } from 'uuid'
import flatten from 'flat'
import addrs from 'email-addresses'
import ksuid from 'ksuid'
import oerror from '@overleaf/o-error'
import makeAndPostMaskedPdf from './pdfgen.mjs'
import ml from '@trellisfw/masklink'
import tsig from '@trellisfw/signatures'

import config from './config.js'

const { Service } = Jobs // no idea why I have to do it this way

const error = debug('trellis-shares:error')
const warn = debug('trellis-shares:warn')
const info = debug('trellis-shares:info')
const trace = debug('trellis-shares:trace')

const token = config.get('token')
let domain = config.get('domain') || ''
if (domain.match(/^http/)) domain = domain.replace(/^https:\/\//, '')

if (domain === 'localhost' || domain === 'proxy') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0
}
const SKIN = config.get('skin') || 'default'

//-------------------------------------------------
// Items for masking&signing:
// You can generate a signing key pair by running `oada-certs --create-keys`
const privateJWK = JSON.parse(readFileSync(config.get('privateJWK')));
const publicJWK = tsig.keys.pubFromPriv(privateJWK);
const header = { jwk: publicJWK };
if (privateJWK.jku) header.jku = privateJWK.jku; // make sure we keep jku and kid
if (privateJWK.kid) header.kid = privateJWK.kid;
const signer = config.get('signer');
const type = config.get('signatureType');



const service = new Service('trellis-shares', domain, token, 1, {
  finishReporters: [
    {
      type: 'slack',
      status: 'failure',
      posturl: config.get('slackposturl')
    }
  ]
}) // 1 concurrent job

// 5 min timeout
service.on('share-user-link', config.get('timeout'), newJob)

async function newJob (job, { jobId, log, oada }) {
  // until oada-jobs adds cross-linking, make sure we are linked under pdf's jobs
  trace('Linking job under src/_meta until oada-jobs can do that natively')
  await oada.put({
    path: `${job.config.src}/_meta/services/trellis-shares/jobs`,
    data: {
      [jobId]: { _ref: `resources/${jobId}` }
    }
  })

  // Find the net dest path, taking into consideration chroot
  const dest = job.config.dest
  let destpath = dest
  let chroot = ''
  if (job.config.chroot) {
    chroot = job.config.chroot
    chroot = chroot.replace(/\/$/, '') // no trailing slash
    if (chroot.match(/\/bookmarks$/)) {
      trace(
        'chroot exists and ends in bookmarks, getting rid of bookmarks part'
      )
      chroot = chroot.replace(/\/bookmarks$/, '')
    }
    destpath = `${chroot}${destpath}`
    trace('Final destpath = ', destpath)
  }

  // Get original so we can get ID, and create the srclink
  const orig = await oada.get({ path: job.config.src }).then(r => r.data)
  const srclink = { _id: orig._id }
  let src = _.cloneDeep(orig); // default is we're linking to original resource

  // Now, replace original and sourcelink if we are supposed to make a copy instead of just linking:
  if (job.config.copy) {
    let newid = false;

    // Make a copy, keeping all the common keys between job.copy.original and job.copy.meta
    let meta = await oada
      .get({ path: `${job.config.src}/_meta` })
      .then(r => r.data);
    // flatten() returns a flat object with path:value pairs like:
    // {
    //   "a.b.c": <value>
    //   "d.e": <value>
    // },
    // therefore, _.keys of that is all the paths from the object, regardless of value
    // _.pick will return an object with only the paths you pass.
    // Therefore, _.pick(_.keys(flatten())) will end up with an object only containing the
    // same paths as the "config" object.
    if (_.isObject(job.config.copy.meta)) {
      const meta_paths_to_keep = _.keys(flatten(job.config.copy.meta))
      trace(
        'Have a meta key-pick spec, meta_paths_to_keep = ',
        meta_paths_to_keep
      )
      trace('picking from meta = ', meta)
      meta = _.pick(meta, meta_paths_to_keep)
    }
    // Now we have the proper meta before the copy, add whatever is needed for mask or copy below, then
    // save final meta at the end


    // If masking is requested by the job, the mask library will make the new copy resource (still need to handle meta):
    if (job.config.copy.mask) {
      // This masked copy cannot link to an original unmasked pdf, so we need to remove it from meta,
      // but we should get it's original filename to re-use on the mask:
      let pdf_filename = false;
      if (meta.vdoc && meta.vdoc.pdf) {
        pdf_filename = await oada.get({ path: `/${meta.vdoc.pdf._id}/_meta/filename` }).then(r=>r.data).then(f => 'MASKED-'+f)
        .catch(e => { warn(`WARNING: failed to get PDF filename from original at /${meta.vdoc.pdf._id}/_meta/filename`); return false; })
        // Delete the PDF link in the new copy's meta
        delete meta.vdoc.pdf;
      }

      // Note that maskAndSignRemoteResourceAsNewResource will create a new resource and put new stuff in its meta, but
      // we don't need to load it into our copy of meta because our eventual PUT to meta will just be merged with that.
      trace('masked copy requested: awaiting maskAndSignRemoteResourceAsNewResource...');
      const newid = await ml.maskAndSignRemoteResourceAsNewResource({
        url: `https://${domain}/${orig._id}`,
        privateJWK, 
        signer,
        token: token,
        paths: findPathsToMask(orig, job.config.copy.mask.keys_to_mask),
      });
      // Store a reference in the masked copy back to the original:
      meta.copy = { src: { _ref: newid }, masked: true };

      // Generate and link a PDF if necessary:
      if (job.config.copy.mask.generate_pdf) {
        pdfkey = await makeAndPostMaskedPdf({
          masked: src,
          _id: newid,
          doctype: job.config.doctype,
          filename: pdf_filename,
          domain, token,
        });
        trace(`Created new PDF, linking under the masked copy's meta.vdoc.pdf to resources/${pdfkey}`);
        if (!meta.vdoc) meta.vdoc = {};
        meta.vdoc.pdf = { _id: `resources/${pdfkey}` };
        // The _meta will be put later, same for mask as for copy
      }


    // Otherwise, just a simple copy operation is requested.  Perform the copy on the original resource, then
    // handle meta later the same for both the copy and the mask
    } else {
      trace('Copy requested instead of link, making copy')
  
      // Now get rid of any _ keys
      src = _.omitBy(src, (v, k) => k.match(/^_/))
      meta = _.omitBy(meta, (v, k) => k.match(/^_/))
      // Set the type same as original
      src._type = orig._type;


      // Note: omitting keys on a document with a signature will result in an invalid signature.  Use a mask in that case.
      if (_.isObject(job.config.copy.original)) {
        const orig_paths_to_keep = _.keys(flatten(job.config.copy.original))
        trace(
          'Have an original key-pick spec, orig_paths_to_keep = ',
          orig_paths_to_keep
        )
        src = _.pick(src, orig_paths_to_keep)
      }
      // Create the copy resource
      newid = await oada.post({ path: `/resources`, data: src })
        .then(r=>r.headers['content-location'].replace(/^\//,''));
    }

    // Add ref to original in the copy's _meta: (should we cross-link original->copy to all copies, or only copy->original?)
    meta.copy = { src: { _ref: orig._id } },

    trace('Created copy resource, new id = ', newid)
  }
  // Put the copy's meta:
  await oada.put({ path: `/${newid}/_meta`, data: meta })

  // Reset the srclink to point to the copy now
  srclink._id = newid;
  // Save the new id back to the job config so it can get returned with the result
  job.config.newid = newid;

  // If we want a versioned link to the resource, set _rev on the link we're about to put:
  if (job.config.versioned) srclink._rev = 0

  // Note that the tree is only from dest on down, and does not include the chroot,
  // so we have to implement our own tree put
  const tree = job.config.tree

  trace('primary put: path = ', destpath, ', data = ', srclink)
  const putresid = await putLinkAndEnsureParent({
    path: destpath,
    data: srclink,
    chroot,
    tree,
    oada
  });
  info(`Successfully linked src = `, srclink, ` to dest = ${dest} with chroot ${chroot}`)

  trace('Incrementing share count under src/_meta')
  let shareCount = await oada.get({
    path: `${job.config.src}/_meta/services/trellis-shares/share-count`
  }).then(r => r.data)
  .catch(e => {
    if (!e || e.status !== 404) throw oerror.tag(e, 'Failed to fetch share count, non-404 error status returned');
    return 0; // no share-count there, so it's just initialized to 0
  })
  trace(`Retrieved share-count = ${shareCount}, PUTting new incremented count`)
  await oada.put({
    path: `${job.config.src}/_meta/services/trellis-shares`,
    data: { 'share-count': shareCount + 1 }
  });

  if (!job.config.skipCreatingEmailJobs) {
    // this flag is mainly for testing
    // HARDCODED UNTIL AINZ CAN DO THIS INSTEAD
    await createEmailJobs({ oada, job })
  }

  return job.config // for lack of something better to put in the result...
}

// Since we know the last key is a link key, treat it differently because if the
// link already exists, we don't want to put directly to that endpoint because it
// will write to the resource instead of the parent.
async function putLinkAndEnsureParent ({ path, data, chroot, tree, oada }) {
  const parts = jsonpointer.parse(path)
  const linkkey = parts[parts.length - 1]
  path = jsonpointer.compile(_.slice(parts, 0, parts.length - 1))
  trace('#putLinkAndEnsureParent: Bottom-level linkkey = ', linkkey)
  data = { [linkkey]: data }

  // ensure the parent:
  const exists = await oada
    .get({ path })
    .then(r => r.status)
    .catch(e => e.status)
  trace(
    `#putLinkAndEnsureParent: After getting path ${path}, exists (status) = ${exists}`
  )
  if (exists === 404) {
    // parent does not exist, need to create a resource and link in it's parent
    trace(
      `#putLinkAndEnsureParent: Destination parent ${path} did not exist, creating...`
    )
    const treeobj = jsonpointer.get(tree, path.replace(chroot, ''))
    if (!treeobj)
      throw new Error(
        `The specified path does not exist in tree after removing chroot.  Path = ${path.replace(
          chroot,
          ''
        )}`
      )
    const _type = treeobj._type
    const _rev = treeobj._rev
    if (!_type)
      throw new Error(
        `Currently this chroot tree put does not allow non-resource parts of the tree and we have a part without a _type`
      )

    // Create a resource, put link into it's parent
    const newid = await oada.post({
      path: '/resources',
      headers: { 'content-type': _type },
      data: {}
    }).then(r => r.headers['content-location'].replace(/^\//, ''))
    trace(`#putLinkAndEnsureParent: posted new resource to /resources for the child, newid = ${newid}`)

    const newlink = { _id: newid }
    if (_rev) newlink._rev = 0 // if tree asked for versioned

    trace(
      `#putLinkAndEnsureParent: recursively running now for path ${path} and data`,
      data
    )
    await putLinkAndEnsureParent({ path, data: newlink, chroot, tree, oada })
  }
  trace(
    `Destination parent ${path} now is known to exist, putting to path = ${path}, data = `,
    data
  )

  // If we get here, parent exists and we can put, no need for content-type
  return await oada.put({ path, data }).then(r => r.headers['content-location'])
}

async function createEmailJobs ({ oada, job }) {
  // We just linked a doctype into a user, lookup the trading partner id for
  // that user and use the doc type to figure out which email list
  let tpid = job.config.chroot.replace(
    /^.*trading-partners\/([^\/]+)(\/.*)$/,
    '$1'
  )
  trace(`createEmailJobs: tpid = `, tpid)

  const doctype = job.config.doctype
  const usertoken = uuidv4().replace(/-/g, '')
  const d = {
    clientId: 'SERVICE-CLIENT-TRELLIS-SHARES',
    user: { _id: job.config.user.id },
    token: usertoken,
    scope: ['all:all'],
    createTime: Date.now(),
    expiresIn: 90 * 24 * 3600 * 1000 // 90 days, in milliseconds
  }

  trace(
    `createEmailJobs: posting to /authorizations for user `,
    job.config.user.id,
    ', body = ',
    d
  )
  const auth = await oada
    .post({
      path: '/authorizations',
      data: d,
      headers: { 'content-type': 'application/vnd.oada.authorization.1+json' }
    })
    .then(r => r.data)
    .catch(e => {
      info(
        'FAILED to post to /authorizations for user ',
        job.config.user.id,
        ', error was: ',
        e
      )
      throw e
    })
  trace('createEmailJobs: auth post finished, auth = ', auth)
  let emails = ''
  let subject = ''
  switch (doctype) {
    case 'cois':
      emails = await oada
        .get({
          path: `/bookmarks/trellisfw/trading-partners/${tpid}/coi-emails`
        })
        .then(r => r.data)
      subject = 'New certificate of insurance available'
      break
    case 'letters-of-guarantee':
      emails = await oada
        .get({
          path: `/bookmarks/trellisfw/trading-partners/${tpid}/coi-emails`
        })
        .then(r => r.data)
      subject = 'New letter of guarantee available'
      break
    case 'fsqa-certificates':
      emails = await oada
        .get({
          path: `/bookmarks/trellisfw/trading-partners/${tpid}/fsqa-emails`
        })
        .then(r => r.data)
      subject = 'New FSQA certificate available'
      break
    case 'fsqa-audits':
      emails = await oada
        .get({
          path: `/bookmarks/trellisfw/trading-partners/${tpid}/fsqa-emails`
        })
        .then(r => r.data)
      subject = 'New FSQA Audit available'
      break
    default:
      throw new Error(
        `ERROR: doctype ${doctype} is not recognized, no email job created`
      )
  }

  const jobkey = await oada
    .post({
      path: '/resources',
      data: {
        service: 'abalonemail',
        type: 'email',
        config: {
          multiple: false,
          to: addrs.parseAddressList(emails).map(({ name, address }) => ({
            name: name || undefined,
            email: address
          })),
          from: 'info@dev.trellis.one',
          subject: `Trellis notification: ${subject}`,
          templateData: {
            recipients: emails,
            link: `https://trellisfw.github.io/conductor?d=${domain}&t=${usertoken}&s=${SKIN}`
          },
          html: template.html,
          attachments: template.attachments
        }
      }
    })
    .then(r => r.headers['content-location'].replace(/^\/resources\//, ''))

  // Link into abalonemail queue
  await oada.put({
    path: `/bookmarks/services/abalonemail/jobs`,
    data: { [jobkey]: { _id: `resources/${jobkey}` } },
    tree
  })
  info('Posted email job for trading partner ', tpid)
}

service.start().catch(e => console.error('Service threw uncaught error: ', e))


//----------------------------------------------------------------------------------------
// Recursive function that returns a flat list of json-pointer paths to any matching keys
function findPathsToMask(obj,previouspath) {
  const jp = jsonpointer.parse(previouspath);
  return _.reduce(_.keys(obj), (acc,k) => {
    const curpath = jsonpointer.compile([...jp, k]);
    if (_.includes(KEYS_TO_MASK, k)) {
      acc.push(curpath);
      return acc;
    }
    if (typeof obj[k] === 'object') {
      // recursively keep looking for paths
      return acc.concat(findPathsToMask(obj[k], curpath));
    }
    return acc;
  }, []);
}


