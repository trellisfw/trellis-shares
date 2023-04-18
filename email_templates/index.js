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

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const images = await readdir('./email_templates/images');

let index = await readFile('./email_templates/index.html').toString();

export const attachments = [];
for await (const image of images) {
  const content = Buffer.from(
    await readFile(join('email_templates', 'images', image))
  ).toString('base64');
  const contentId = image;

  index = index.replace(`images/${image}`, `cid:${image}`);

  attachments.push({
    content,
    // eslint-disable-next-line camelcase
    content_id: contentId,
    filename: image,
    disposition: 'inline',
  });
}

export const html = index;
