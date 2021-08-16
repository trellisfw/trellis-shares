/* Copyright 2020 Qlever LLC
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import convict from 'convict';
// @ts-ignore
import convictMoment from 'convict-format-with-moment';
import convictValidator from 'convict-format-with-validator';
import { config as load } from 'dotenv';

load();

convict.addFormats(convictMoment);
// @ts-ignore
convict.addFormats(convictValidator);

const config = convict({
  oada: {
    domain: {
      doc: 'OADA API domain',
      format: String,
      default: 'localhost',
      env: 'DOMAIN',
      arg: 'domain',
    },
    token: {
      doc: 'OADA API token',
      format: String,
      default: 'god',
      env: 'TOKEN',
      arg: 'token',
    },
  },
  slack: {
    posturl: {
      format: 'url',
      // use a real slack webhook URL
      default: 'https://localhost',
      env: 'SLACK_WEBHOOK',
      arg: 'slack-webhook',
    },
  },
  timeout: {
    format: 'duration',
    // The types for duration suck
    default: ((5 * 60 * 1000) as unknown) as number,
  },
  email: {
    skin: {
      doc: 'Used for abalonemail job creation',
      format: String,
      default: 'default',
    },
  },
  signing: {
    signatureType: {
      format: String,
      default: 'transcription',
      env: 'SIGNATURE_TYPE',
      arg: 'signature-type',
    },
    privateJWK: {
      format: String,
      default: './keys/private_key.jwk',
      env: 'SIGNATURE_JWK',
      arg: 'signature-jwk',
    },
    signer: {
      name: {
        format: String,
        default: 'Dev signer',
        env: 'SIGNER_NAME',
        arg: 'signer-name',
      },
      url: {
        format: 'url',
        default: 'https://oatscenter.org',
        env: 'SIGNER_URL',
        arg: 'signer-url',
      },
    },
  },
});

/**
 * Error if our options are invalid.
 * Warn if extra options found.
 */
config.validate({ allowed: 'warn' });

export default config;
