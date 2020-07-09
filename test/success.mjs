import _ from 'lodash'
import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import oada from '@oada/client'
import Promise from 'bluebird'
import moment from 'moment'

import config from '../config.js'

chai.use(chaiAsPromised)
const expect = chai.expect

let jobkey = false
const jobpath = `/bookmarks/services/trellis-shares/jobs`
const coikey = 'TEST-COI5-DUMMY'

const tree = {
  bookmarks: {
    _type: 'application/vnd.oada.bookmarks.1+json',
    services: {
      _type: 'application/vnd.oada.services.1+json',
      'trellis-shares': {
        _type: 'application/vnd.oada.service.1+json',
        jobs: {
          _type: 'application/vnd.oada.jobs.1+json',
          '*': {
            _type: 'application/vnd.oada.job.1+json'
          }
        }
      }
    },
    trellisfw: {
      _type: 'application/vnd.trellis.1+json',
      cois: {
        _type: 'application/vnd.trellis.cois.1+json',
        '*': {
          _type: 'application/vnd.trellis.coi.1+json'
        }
      }
    }
  }
}

let jobcfg = {}

process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0
describe('success job', () => {
  let con = false

  before(async function () {
    this.timeout(10000)
    console.log('Before 1: started')
    const domain = config.get('domain').replace(/^https:\/\//, '')
    console.log('Before 2: connecting to oada')
    con = await oada.connect({ domain, token: config.get('token') })
    console.log('Before 3: connected.  Cleaning up as needed.')

    //------------------------------------------
    // Do some cleanup: get rid of src, dest, fakeuser
    await Promise.each(
      [`/resources/${coikey}`, `/bookmarks/trellisfw/cois/${coikey}`],
      path =>
        con
          .get({ path })
          .then(() => con.delete({ path })) // delete it if it exists
          .catch(e => {}) // ignore if it doesn't
    )

    // Create the dummy coi and link
    console.log('Before: creating dummy COI')
    await con.put({
      path: `/resources/${coikey}`,
      headers: { 'content-type': 'application/vnd.trellis.coi.1+json' },
      data: {
        holder: {
          name: 'test name'
        }
      }
    })
    console.log('Before: linking dummy COI')
    await con.put({
      path: `/bookmarks/trellisfw/cois`,
      tree,
      data: {
        [coikey]: { _id: `resources/${coikey}`, _rev: 0 }
      }
    })

    console.log('Before: getting first trading partner to use as guinea pig')
    const tp = await con
      .get({ path: '/bookmarks/trellisfw/trading-partners' })
      .then(r => _.filter(_.keys(r.data), k => !k.match(/^_/))[0])
      .then(tpid =>
        con.get({ path: `/bookmarks/trellisfw/trading-partners/${tpid}` })
      )
      .then(r => r.data)
    console.log('Before: using trading-partner ', tp)
    const tpkey = tp._id.replace(/^resources\//, '')

    jobcfg = {
      doctype: 'cois',
      src: `/bookmarks/trellisfw/cois/${coikey}`,
      dest: `/bookmarks/trellisfw/cois/${coikey}`,
      chroot: `/bookmarks/trellisfw/trading-partners/${tpkey}/user/bookmarks`,
      user: tp.user,
      tree
    }

    console.log('Before: posting job to get job key')
    //--------------------------------------------------------
    // Example of a successful normal job: go ahead and put that up, tests will check results later
    jobkey = await con
      .post({
        path: `/resources`,
        headers: { 'content-type': 'application/vnd.oada.job.1+json' },
        data: {
          service: 'trellis-shares',
          type: 'share-user-link',
          config: jobcfg
        }
      })
      .then(r => r.headers['content-location'].replace(/^\/resources\//, ''))
    console.log('Before: job posted, key = ', jobkey)

    // Link job under queue to start things off:
    console.log(`Before: linking job at ${jobpath}/${jobkey}`)
    await con.put({
      path: `${jobpath}/${jobkey}`,
      data: { _id: `resources/${jobkey}` }
    })
    console.log(`Before: job linked, waiting to for it to finish`)
    await Promise.delay(1000)
    console.log('Before: finished, running tests')
  })

  // Now the real checks begin.  Did trellis-shares:
  // 1: dest exists
  // 2: dest._id is same src._id
  // 3: create abalonemail job with legit token for conductor

  it('should create the dest endpoint with same _id as src', async () => {
    const destpath = jobcfg.chroot.replace(/\/bookmarks$/, '') + jobcfg.dest
    const srcdata = await con.get({ path: jobcfg.src }).then(r => r.data)
    const destdata = await con.get({ path: destpath }).then(r => r.data)
    expect(destdata._id).to.equal(srcdata._id)
  })

  it('should have status of success on the job when completed', async () => {
    const result = await con
      .get({ path: `resources/${jobkey}/status` })
      .then(r => r.data)
    expect(result).to.equal('success')
  })

  it('should delete the job from jobs', async () => {
    const result = await con.get({ path: `${jobpath}/${jobkey}` }).catch(e => e) // returns the error
    expect(result.status).to.equal(404)
  })

  it("should put the job under today's day-index within jobs-success", async () => {
    const day = moment().format('YYYY-MM-DD')
    const result = await con
      .get({
        path: `/bookmarks/services/trellis-shares/jobs-success/day-index/${day}/${jobkey}`
      })
      .then(r => r.data)
    expect(result._id).to.equal(`resources/${jobkey}`)
  })
})
