# trellis-shares

A microservice to process sharing jobs. A sharing job shares a document from a
`src` to a `destination`.

In its current form, it accepts jobs that look like this:

```http
POST /bookmarks/services/trellis-shares/jobs
{
  service: 'trellis-shares',
  type: 'share-user-link',
  config: {
    src: { _id: 'resources/123abc' },
    versioned: false, // do you want to link with _rev or not
    // Where to link from root
    dest: '/bookmarks/trellisfw/fsqa-audits/123abc',
    // If you want to shift root elsewhere
    chroot: '/bookmarks/trellisfw/trading-partners/987def/user/bookmarks'
    doctype: 'audits',
    tree: { ... a usual tree, representing only dest path (ignoring chroot) ... }
  }
}
```

Note that technically "bookmarks" is repeated twice, but the library removes one of
them when smashing the strings together. Tree shold be rooted at the dest rather than
trying to include the chroot and the dest.

## Installation

```docker-compose
cd path/to/your/oada-srvc-docker
cd services-available
git clone git@github.com:trellisfw/trellis-shares.git
cd ../services-enabled
ln -s ../services-available/trellis-shares .
oada up -d trellis-shares
```

## Overriding defaults for Production

Using the common `z_tokens` method outlined for `oada-srvc-docker`, the following entries
for the `z_tokens` docker-compose file will work:

```docker-compose
  trellis-shares:
    volumes:
      - ./services-available/z_tokens/private_key.jwk:/private_key.jwk
    environment:
      - token=atokentouseinproduction
      - domain=your.trellis.domain
```
