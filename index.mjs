import { readFileSync } from 'fs';
import Promise from 'bluebird';
import _ from 'lodash';
import debug from 'debug';
import Jobs from '@oada/jobs';
import tree from './tree.js';
import jsonpointer from 'json-pointer';
import template from './email_templates/index.js';
import { v4 as uuidv4 } from 'uuid';

import config from './config.js'

const { Service } = Jobs; // no idea why I have to do it this way

const error = debug('trellis-shares:error');
const warn = debug('trellis-shares:warn');
const info = debug('trellis-shares:info');
const trace = debug('trellis-shares:trace');

const TOKEN = config.get('token');
let DOMAIN = config.get('domain') || '';
if (DOMAIN.match(/^http/)) DOMAIN = DOMAIN.replace(/^https:\/\//, '');

if (DOMAIN === 'localhost') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0;
}


const service = new Service('trellis-shares', DOMAIN, TOKEN, 1, {
  finishReporters: [ 
    { 
      type: 'slack', 
      status: 'failure', 
      posturl: config.get('slackposturl'),
    } 
  ]
}); // 1 concurrent job



// 5 min timeout
service.on('share-user-link', config.get('timeout'), newJob);

async function newJob(job, { jobId, log, oada }) {
  // until oada-jobs adds cross-linking, make sure we are linked under pdf's jobs
  trace('Linking job under src/_meta until oada-jobs can do that natively');
  await oada.put({ path: `${job.config.src}/_meta/services/trellis-shares/jobs`, data: {
    [jobId]: { _ref: `resources/${jobId}` },
  }});
 
  // Find the net dest path, taking into consideration chroot
  const dest = job.config.dest;
  let destpath = dest;
  let chroot = '';
  if (job.config.chroot) {
    chroot = job.config.chroot;
    chroot = chroot.replace(/\/$/,''); // no trailing slash
    if (chroot.match(/\/bookmarks$/)) {
      trace('chroot exists and ends in bookmarks, getting rid of bookmarks part');
      chroot = chroot.replace(/\/bookmarks$/,'');
    }
    destpath = `${chroot}${destpath}`;
    trace('Final destpath = ', destpath);
  }

  // Compute the srclink (versioned or not)
  const srclink = await oada.get({path: job.config.src }).then(r=>({_id: r.data._id}));
  if (job.config.versioned) srclink._rev = 0;

  // Note that the tree is only from dest on down, and does not include the chroot,
  // so we have to implement our own tree put
  const tree = job.config.tree;

  trace('primary put: path = ', destpath, ', data = ', srclink);
  const putresid = await putLinkAndEnsureParent({ path: destpath, data: srclink, chroot, tree, oada});
  info(`Successfully linked src = ${job.config.src} to dest = ${dest} with chroot ${chroot}`);


  // HARDCODED UNTIL AINZ CAN DO THIS INSTEAD
  await createEmailJobs({oada,job});


  return job.config; // for lack of something better to put in the result...
}

// Since we know the last key is a link key, treat it differently because if the
// link already exists, we don't want to put directly to that endpoint because it
// will write to the resource instead of the parent.
async function putLinkAndEnsureParent({path, data, chroot, tree, oada}) {
  const parts = jsonpointer.parse(path);
  const linkkey = parts[parts.length-1];
  path = jsonpointer.compile(_.slice(parts, 0, parts.length-1));
  trace('Bottom-level linkkey = ', linkkey);
  data = { [linkkey]:  data }

  // ensure the parent:
  const exists = oada.get({path}).then(r=>r.status).catch(e=>e.status);
  if (exists === 404) { // parent does not exist, need to create a resource and link in it's parent
    trace(`Destination parent ${path} did not exist, creating...`);
    const treeobj = jsonpointer.get(tree, path.replace(chroot,''));
    if (!treeobj) throw new Error(`The specified path does not exist in tree after removing chroot.  Path = ${path.replace(chroot,'')}`);
    const _type = treeobj._type;
    const _rev = treeobj._rev;
    if (!_type) throw new Error(`Currently this chroot tree put does not allow non-resource parts of the tree and we have a part without a _type`);

    // Create a resource, put link into it's parent
    const newid = await oada.post({path: '/resources', headers: { 'content-type': _type }, data: {} })
      .then(r=>r.headers['content-location'].replace(/^\//,''));
    const newlink = { _id: newid };
    if (_rev) newlink._rev = 0; // if tree asked for versioned
    
    await putLinkAndEnsureParent({path, data: newlink, chroot, tree})
  }
  console.log('Destination parent ${path} now is known to exist, putting to path = ', path, ', data = ', data);
  
  // If we get here, parent exists and we can put, no need for content-type
  return await oada.put({path,data}).then(r=>r.headers['content-location']);
}


async function createEmailJobs({oada,job}) {
  // We just linked a doctype into a user, lookup the trading partner id for 
  // that user and use the doc type to figure out which email list
  let tpid = job.config.chroot.replace(/^.*trading-partners\/([^\/]+)(\/.*)$/,'$1');
  trace(`createEmailJobs: tpid = `, tpid);

  const doctype = job.config.doctype;
  const usertoken = uuidv4().replace(/-/g,'');
  const d = {
    clientId: 'SERVICE-CLIENT-TRELLIS-SHARES',
    user: { _id: job.config.user.id },
    token: usertoken,
    scope: [ 'all:all' ],
    createTime: Date.now(),
    expiresIn: 90*24*3600, // 90 days
  };

  trace(`createEmailJobs: posting to /authorizations for user `, job.config.user.id, ', body = ', d);
  const auth = await oada.post({ path: '/authorizations', data: d,
    headers: { 'content-type': 'application/vnd.oada.authorization.1+json' } 
  }).then(r=>r.data)
  .catch(e => {
    info('FAILED to post to /authorizations for user ', job.config.user.id, ', error was: ', e);
    throw e;
  });
  trace('createEmailJobs: auth post finished, auth = ', auth);
  let emails = '';
  let subject = '';
  switch(doctype)  {
    case 'cois':
      emails = await oada.get({ path: `/bookmarks/trellisfw/trading-partners/${tpid}/coi-emails` }).then(r=>r.data);
      subject = 'New certificate of insurance available';
    break;
    case 'letters-of-guarantee':
      emails = await oada.get({ path: `/bookmarks/trellisfw/trading-partners/${tpid}/coi-emails` }).then(r=>r.data);
      subject = 'New letter of guarantee available';
    break;
    case 'fsqa-certificates':
      emails = await oada.get({ path: `/bookmarks/trellisfw/trading-partners/${tpid}/fsqa-emails` }).then(r=>r.data);
      subject = 'New FSQA certificate available';
    break;
    case 'fsqa-audits':
      emails = await oada.get({ path: `/bookmarks/trellisfw/trading-partners/${tpid}/fsqa-emails` }).then(r=>r.data);
      subject = 'New FSQA Audit available';
    break;
    default: 
      throw new Error(`ERROR: doctype ${doctype} is not recognized, no email job created`);
  }

  const jobkey = await oada.post({ path: '/resources', data: {
    service: 'abalonemail',
    type: 'email',
    config: {
      multiple: false,
      to: emails,
      from: "info@dev.trellis.one",
      subject: `Trellis notification: ${subject}`,
      templateData: {
        recipients: emails,
        link: `https://trellisfw.github.io/conductor?d=${DOMAIN}&t=${usertoken}`,
      },
      html: template.html,
      attachments: template.attachements,
    },
  }}).then(r=>r.headers['content-location'].replace(/^\/resources\//,''));

  // Link into abalonemail queue
  await oada.put({ path: `/bookmarks/services/abalonemail/jobs`, data: { [jobkey]: { _id: `resources/${jobkey}` } }, tree});
  info('Posted email job for trading partner ', tpid);
}

service.start().catch(e => 
  console.error('Service threw uncaught error: ',e)
);
