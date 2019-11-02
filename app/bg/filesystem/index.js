import { join as joinPath } from 'path'
import * as logLib from '../logger'
const logger = logLib.category('filesystem')
import slugify from 'slugify'
import dat from '../dat/index'
import * as db from '../dbs/profile-data-db'
import * as users from './users'
import * as trash from './trash'
import { PATHS } from '../../lib/const'

// typedefs
// =

/**
 * @typedef {import('../dat/daemon').DaemonDatArchive} DaemonDatArchive
 * @typedef {import('./users').User} User
 */

// globals
// =

var browsingProfile
var rootArchive

// exported api
// =

/**
 * @returns {DaemonDatArchive}
 */
export function get () {
  return rootArchive
}

/**
 * @param {string} url
 * @returns {boolean}
 */
export function isRootUrl (url) {
  return url === browsingProfile.url
}

/**
 * @returns {Promise<void>}
 */
export async function setup () {
  trash.setup()

  // create the root archive as needed
  browsingProfile = await db.get(`SELECT * FROM profiles WHERE id = 0`)
  if (!browsingProfile.url) {
    let archive = await dat.archives.createNewRootArchive()
    logger.info('Root archive created', {url: archive.url})
    await db.run(`UPDATE profiles SET url = ? WHERE id = 0`, [archive.url])
    browsingProfile.url = archive.url
  }

  // load root archive
  rootArchive = await dat.archives.getOrLoadArchive(browsingProfile.url)

  // setup users
  var userList = await users.setup()

  // enforce root files structure
  logger.info('Loading root archive', {url: browsingProfile.url})
  try {
    // ensure common dirs
    await ensureDir(PATHS.DATA)
    await ensureDir(PATHS.DATA_NS('unwalled.garden'))
    await ensureDir(joinPath(PATHS.DATA_NS('unwalled.garden'), 'bookmarks'))
    await ensureDir(PATHS.LIBRARY)
    await ensureDir(PATHS.SETTINGS)

    // ensure all user mounts are set
    await ensureDir(PATHS.USERS)
    for (let user of userList) {
      if (user.isDefault) await ensureMount(PATHS.DEFAULT_USER, user.url)
      if (!user.isTemporary) {
        await ensureMount(PATHS.USER(user.label), user.url)
      }
    }

    // clear out any old user mounts
    let usersFilenames = await rootArchive.pda.readdir(PATHS.USERS)
    for (let filename of usersFilenames) {
      if (!userList.find(u => u.label === filename)) {
        let path = PATHS.USER(filename)
        let st = await stat(path)
        if (st && st.mount) {
          logger.info('Removing old /users mount', {path})
          await rootArchive.pda.unmount(path)
        }
      }
    }

    // TODO remove /users mounts under old labels
  } catch (e) {
    console.error('Error while constructing the root archive', e)
    logger.error('Error while constructing the root archive', e)
  }
}

/**
 * @param {User} user
 * @returns {Promise<void>}
 */
export async function addUser (user) {
  await ensureMount(PATHS.USER(user.label), user.url)
  if (user.isDefault) await ensureMount(PATHS.DEFAULT_USER, user.url)
}

/**
 * @param {User} user
 * @returns {Promise<void>}
 */
export async function removeUser (user) {
  await ensureUnmount(PATHS.USER(user.label))
}

/**
 * @param {string} url
 * @param {string} title
 * @returns {Promise<void>}
 */
export async function addToLibrary (url, title) {
  var name = await getAvailableName(PATHS.LIBRARY, title)
  await ensureMount(joinPath(PATHS.LIBRARY, name), url)
}

// internal methods
// =

async function stat (path) {
  try { return await rootArchive.pda.stat(path) }
  catch (e) { return null }
}

async function ensureDir (path) {
  try {
    let st = await stat(path)
    if (!st) {
      logger.info(`Creating directory ${path}`)
      await rootArchive.pda.mkdir(path)
    } else if (!st.isDirectory()) {
      logger.error('Warning! Filesystem expects a folder but an unexpected file exists at this location.', {path})
    }
  } catch (e) {
    logger.error('Filesystem failed to make directory', {path, error: e})
  }
}

async function ensureMount (path, url) {
  try {
    let st = await stat(path)
    let key = await dat.archives.fromURLToKey(url, true)
    if (!st) {
      // add mount
      logger.info(`Adding mount ${path}`, {key})
      await rootArchive.pda.mount(path, key)
    } else if (st.mount) {
      if (st.mount.key.toString('hex') !== key) {
        // change mount
        logger.info('Reassigning mount', {path, key, oldKey: st.mount.key.toString('hex')})
        await rootArchive.pda.unmount(path)
        await rootArchive.pda.mount(path, key)
      }
    } else {
      logger.error('Warning! Filesystem expects a mount but an unexpected file exists at this location.', {path})
    }
  } catch (e) {
    logger.error('Filesystem failed to mount archive', {path, url, error: e})
  }
}

async function ensureUnmount (path) {
  try {
    let st = await stat(path)
    if (st && st.mount) {
      // remove mount
      logger.info('Removing mount', {path})
      await rootArchive.pda.unmount(path)
    }
  } catch (e) {
    logger.error('Filesystem failed to unmount archive', {path, error: e})
  }
}

/**
 * @param {string} containingPath
 * @param {string} title
 * @returns {Promise<string>}
 */
async function getAvailableName (containingPath, title) {
  var basename = slugify((title || '').trim() || 'untitled').toLowerCase()
  for (let i = 1; i < 1e9; i++) {
    let name = (i === 1) ? basename : `${basename}-${i}`
    let st = await stat(joinPath(containingPath, name))
    if (!st) return name
  }
  // yikes if this happens
  throw new Error('Unable to find an available name for ' + title)
}