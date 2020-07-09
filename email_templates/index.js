import fs from 'fs'
import { join } from 'path'

const images = fs.readdirSync('./email_templates/images')

let html = fs.readFileSync('./email_templates/index.html').toString()

const attachments = []
for (const image of images) {
  const content = Buffer.from(
    fs.readFileSync(join('email_templates', 'images', image))
  ).toString('base64')
  const contentId = image

  html = html.replace(`images/${image}`, `cid:${image}`)

  attachments.push({
    content,
    content_id: contentId,
    filename: image,
    disposition: 'inline'
  })
}

export default {
  html,
  attachments
}
