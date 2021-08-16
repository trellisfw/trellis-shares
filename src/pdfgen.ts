import fs from 'fs';
import querystring from 'querystring'; // this is built-in to node
import _ from 'lodash';
import pdfjs from 'pdfjs';
import helvetica from 'pdfjs/font/Helvetica';
import helvetica_bold from 'pdfjs/font/Helvetica-Bold';
import courier from 'pdfjs/font/Courier';
import debug from 'debug';
import jsonpointer from 'json-pointer';
import moment, { Moment } from 'moment';
import wrap from 'wrap-ansi';
import axios from 'axios';
import oerror from '@overleaf/o-error';
import ksuid from 'ksuid';

import ml from '@trellisfw/masklink';

const error = debug('trellis-shares#pdfgen:error');
//const warn = debug('trellis-shares#pdfgen:warn');
const info = debug('trellis-shares#pdfgen:info');
const trace = debug('trellis-shares#pdfgen:trace');

// Read in any images or other files for the PDF
const logo = new pdfjs.Image(
  fs.readFileSync('./pdf-assets/logo-masklink-green.jpg')
);

interface Row {
  key: string;
  value?: string;
  mask?: any;
}

// Give this thing the actual JSON document that needs to be turned into a PDF.
// It will return the new _id for the posted PDF
// You have to pass the domain and token because the default oada con websocket can't send
// binary data.  Therefore, we have to make a new connection to the same place with websocket off.
// Filename is put in the PDF's meta.
// _id is the _id of the masked resource whose content is in the "masked" parameter
async function makeAndPostMaskedPdf({
  masked,
  _id,
  doctype,
  filename,
  domain,
  token,
}: {
  masked: any;
  _id: string;
  doctype: 'fsqa-audits' | 'cois';
  filename: string;
  domain: string;
  token: string;
}) {
  try {
    trace('makeAndPostMaskedPdf: creating pdf for doctype %s', doctype);
    if (!domain.match(/^http/)) {
      domain = 'https://' + domain;
    }

    if (!filename)
      filename = 'TrellisMaskAndLink-' + (await ksuid.random()) + '.pdf';

    const doc = new pdfjs.Document({
      font: helvetica,
      padding: 10,
      lineHeight: 1.2,
    });
    doc.info.creationDate = new Date();
    doc.info.producer =
      'Trellis-Shares via Mask and Link, from The Trellis Framework (https://github.com/trellisfw) hosted by the OATS Center (https://oatscenter.org) at Purdue University';
    trace('PDF object created, creator info is set.  Creating header:');

    // From: http://pdfjs.rkusa.st/

    //-------------------
    // The header:
    const header = doc
      .header()
      .table({ widths: [null, null], paddingBottom: 1.0 * pdfjs.cm })
      .row();
    header.cell().image(logo, { height: 2 * pdfjs.cm });
    header
      .cell()
      .text({ textAlign: 'right' })
      .add('Trellis - Mask & Link\n', { fontSize: 14, font: helvetica_bold })
      // @ts-ignore
      .text({ textAlign: 'right' })
      .add('A masked document shielding confidential information\n')
      .add('https://github.com/trellisfw/trellisfw-masklink', {
        link: 'https://github.com/trellisfw/trellisfw-masklink',
        underline: true,
        color: '0x569cd6',
      });
    trace('Header created, putting masked resource data in PDF');

    trace('Extracting data for %s', doctype);
    const data = pullData(masked, doctype);
    trace(data, 'Got this data for masked resource');

    doc
      .cell({ paddingBottom: 0.5 * pdfjs.cm })
      .text(data.title, { fontSize: 16, font: helvetica_bold });

    const resTable = doc.table({
      widths: [4.0 * pdfjs.cm, null],
      borderHorizontalWidths: function () {
        return 1;
      },
      padding: 5,
    });

    function addRow({ key, value, mask }: Row) {
      trace('Adding row for resource. key = %s', key);
      const tr = resTable.row();
      tr.cell().text(key);
      if (mask) {
        trace(mask, 'Adding mask row for key ' + key);
        tr.cell()
          .text('< MASKED >')
          // @ts-ignore
          .text('If you have permission, click here to verify', {
            link:
              'https://trellisfw.github.io/reagan?trellis-mask=' +
              querystring.escape(JSON.stringify(mask['trellis-mask'])),
            underline: true,
            color: '0x569cd6',
          });
      } else if (value) {
        trace('Adding val to row for key %s val = %s', key, value);
        tr.cell(value);
      }
    }
    _.each(data.rows, addRow);

    trace('Finished adding tables, now adding json');
    // And, in the final pages, add the actual JSON with the signatures
    doc.cell().pageBreak();
    // Make a copy that doesn't have the _ oada keys like _id, _rev, etc.
    const clean = _.omitBy(_.cloneDeep(masked), (_v, k) => k.match(/^_/));

    doc
      .cell({ paddingBottom: 0.5 * pdfjs.cm })
      .text(data.title + ' - Full Signature and Data')
      // @ts-ignore
      .text('Click here to verify full resource if you have permission to it', {
        link:
          'https://trellisfw.github.io/reagan?masked-resource-url=' +
          querystring.escape(`${domain}/${_id}`),
        underline: true,
        color: '0x569cd6',
      });

    doc.cell({ paddingBottom: 0.5 * pdfjs.cm, font: courier }).text(
      wrap(JSON.stringify(clean, null, '  '), 80, {
        hard: true,
        trim: false,
      })
    );

    trace('Done adding things to PDF, sending to OADA');

    // Done!  Now get that as a buffer and POST to OADA, return link for vdoc
    const docbuf = await doc.asBuffer();

    // POST to /resources
    // content-type: application/pdf
    const pdfid = await axios({
      method: 'post',
      url: `${domain}/resources`,
      data: docbuf,
      headers: {
        'content-type': 'application/pdf',
        'authorization': 'Bearer ' + token,
      },
    })
      .then((r) => r.headers['content-location'].slice(1))
      .catch((e) => {
        throw oerror.tag(
          e,
          'ERROR: failed to POST new PDF of masked document to /resources.'
        );
      });
    info('Successfully posted new PDF to ' + pdfid);

    // Put the filename in the pdf's meta
    if (filename) {
      await axios({
        method: 'put',
        url: `${domain}/${pdfid}/_meta`,
        data: { filename },
        headers: {
          'content-type': 'application/json',
          'authorization': 'Bearer ' + token,
        },
      }).catch((e) => {
        throw oerror.tag(
          e,
          `ERROR: failed to put PDF filename into ${pdfid}/_meta`
        );
      });
    }

    return pdfid;
  } catch (e) {
    error(e, 'FAILED to create pdf');
  }
}

function pullData(masked: any, doctype: 'fsqa-audits' | 'cois') {
  let data = {
    title: 'Unknown Document Type',
    rows: [{ key: 'Unknown', value: 'Unrecognized Document' }] as Row[],
  };
  if (doctype === 'fsqa-audits') data = pullAuditData(masked);
  if (doctype === 'cois') data = pullCoIData(masked);
  return data;
}

function capitalizeFirstLetter(string: string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}

function pullAuditData(audit: {
  certificate_validity_period?: { start?: string; end?: string };
  organization?: { name?: string };
  score?: { final?: { value?: string } };
  scope?: { products_observed?: { name: string }[] };
}) {
  trace(audit, 'pdf: pulling audit data from audit');
  let validity: { start: Moment; end: Moment; expired?: boolean } | null = null;
  if (
    audit.certificate_validity_period &&
    audit.certificate_validity_period.start &&
    audit.certificate_validity_period.end
  ) {
    validity = {
      start: moment(audit.certificate_validity_period.start, 'M/D/YYYY'),
      end: moment(audit.certificate_validity_period.end, 'M/D/YYYY'),
    };
    if (!validity.start || !validity.start.isValid()) {
      validity = null;
    } else if (!validity.end || !validity.end.isValid()) {
      validity = null;
    } else {
      const now = moment();
      // If it starts after today, or ended before today, it's expired
      validity.expired =
        validity.start.isAfter(now) || validity.end.isBefore(now);
    }
  }
  const org = (audit.organization && audit.organization.name) || null;
  const score =
    audit.score && audit.score.final ? audit.score.final.value : false;
  const scope =
    audit.scope && audit.scope.products_observed
      ? _.join(
          _.map(audit.scope.products_observed, (p) => p.name),
          ', '
        )
      : false;

  const ret = {
    title: 'FSQA Audit: ' + (org ? org : ''),
    rows: [] as Row[],
  };
  if (org) ret.rows.push({ key: 'Organization:', value: org });
  if (score) ret.rows.push({ key: 'Score:', value: score });
  if (scope) ret.rows.push({ key: 'Scope:', value: scope });
  if (validity)
    ret.rows.push({
      key: 'Validity:',
      value:
        validity.start.format('MMM d, YYYY') +
        ' to ' +
        validity.end.format('MMM d, YYYY'),
    });
  // Add all masked things
  const paths = ml.findAllMaskPathsInResource(audit);
  _.each(paths, (p) => {
    const mask = jsonpointer.get(audit, p);
    const label = _.join(
      _.map(jsonpointer.parse(p), (word) => capitalizeFirstLetter(word)),
      ' '
    );
    ret.rows.push({ key: label, mask });
  });
  trace(ret, 'Pulled rows of data from audit');
  return ret;
}

function pullCoIData(coi: {
  producer?: { name?: string };
  holder?: { name?: string };
  policies?: { number: number; effective_date: string; expire_date: string }[];
}) {
  const producer = (coi && coi.producer && coi.producer.name) || null;
  const holder = (coi.holder && coi.holder.name) || null;
  const _policies = coi.policies || null; // COI has policies
  // Filter policies whose dates we can't parse
  const policies =
    _policies &&
    _.filter(
      _policies as typeof _policies &
        { start: Moment; end: Moment; expired: boolean }[],
      (p) => {
        p.start = moment(p.effective_date);
        p.end = moment(p.expire_date);
        if (!p.start.isValid()) return false;
        if (!p.end.isValid()) return false;
        const now = moment();
        p.expired = p.start.isAfter(now) || p.end.isBefore(now);
        return true; // keep this one in the list
      }
    );

  const ret = {
    title: 'Certificate of Insurance: ' + (producer ? producer : ''),
    rows: [] as Row[],
  };
  if (producer) {
    ret.rows.push({ key: 'Producer', value: producer });
  }
  if (holder) {
    ret.rows.push({ key: 'Holder', value: holder });
  }
  _.each(policies, (p) => {
    ret.rows.push({
      key: `Policy ${p.number}:`,
      value:
        p.start.format('MMM d, YYYY') + ' to ' + p.end.format('MMM d, YYYY'),
    });
  });
  const paths = ml.findAllMaskPathsInResource(coi);
  _.each(paths, (p) => {
    const mask = jsonpointer.get(coi, p);
    const label = _.join(
      _.map(jsonpointer.parse(p), (word) => capitalizeFirstLetter(word)),
      ' '
    );
    ret.rows.push({ key: label, mask });
  });
  return ret;
}

export default makeAndPostMaskedPdf;
