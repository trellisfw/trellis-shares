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

export default {
  bookmarks: {
    _type: 'application/vnd.oada.bookmarks.1+json',
    trellisfw: {
      _type: 'application/vnd.trellis.1+json',
    },
    services: {
      '_type': 'application/vnd.oada.services.1+json',
      '*': {
        // We will post to shares/jobs
        _type: 'application/vnd.oada.service.1+json',
        jobs: {
          '_type': 'application/vnd.oada.service.jobs.1+json',
          '*': {
            _type: 'application/vnd.oada.service.job.+1json',
          },
        },
      },
    },
  },
} as const;
