import * as fs from 'fs-extra'
import * as path from 'path'
import { extract, parse } from 'jest-docblock'
import grayMatter from 'gray-matter'
import { defaultFindPages as _defaultFindPages } from './find-pages-strategy/default'
import { globFind } from './find-pages-strategy/utils'
import slash from 'slash'

export interface FindPagesHelpers {
  /**
   * readFile util with cache
   */
  readonly readFile: (filePath: string) => Promise<string>
  /**
   * Read the static data from a file.
   */
  readonly extractStaticData: (
    filePath: string
  ) => Promise<{
    readonly [key: string]: any
    readonly sourceType: string
  }>
  /**
   * Glob utils. Return matched file paths.
   */
  readonly globFind: (
    baseDir: string,
    glob: string
  ) => Promise<
    ReadonlyArray<{
      readonly relative: string
      readonly absolute: string
    }>
  >
  /**
   * Use the basic filesystem routing convention to find pages.
   */
  readonly defaultFindPages: (
    baseDir: string
  ) => Promise<ReadonlyArray<PageData>>
  /**
   * Register page data.
   * User who custom findPages should use it to register the data he/she finds.
   */
  readonly addPageData: (pageData: PageData) => void
}

export interface PageData {
  /**
   * The page route path.
   * User can register multiple page data with same pageId,
   * as long as they have different keys.
   * Page data with same pageId will be merged.
   *
   * @example '/posts/hello-world'
   */
  readonly pageId: string
  /**
   * The data key.
   * If it conflicts with an already-registered data,
   * error will be thrown.
   *
   * @default 'main'
   */
  readonly key?: string
  /**
   * The path to the runtime data module
   */
  readonly dataPath?: string

  readonly staticData?: any
}

export async function collectPagesData(
  pagesDir: string,
  findPages?: (helpers: FindPagesHelpers) => Promise<void>
): Promise<FindPagesResult> {
  const [pages, findPagesHelpers] = createFindPagesContext()
  if (typeof findPages === 'function') {
    await findPages(findPagesHelpers)
  } else {
    const found = await findPagesHelpers.defaultFindPages(pagesDir)
    found.forEach(findPagesHelpers.addPageData)
  }
  return pages
}

export async function renderPageList(pagesData: FindPagesResult) {
  const addPagesData = Object.entries(pagesData).map(
    ([pageId, { staticData }]) => {
      let subPath = pageId
      if (subPath === '/') {
        // import("@!virtual-modules/pages/") would make vite confused
        // so we change the sub path
        subPath = '/__index'
      }
      const code = `
pages["${pageId}"] = {};
pages["${pageId}"].data = () => import("@!virtual-modules/pages${subPath}");
pages["${pageId}"].staticData = ${JSON.stringify(staticData)};`
      return code
    }
  )
  return `
const pages = {};
${addPagesData.join('\n')}
export default pages;
`
}

export async function renderPageListInSSR(pagesData: FindPagesResult) {
  const addPagesData = Object.entries(pagesData).map(
    ([pageId, { staticData }], index) => {
      let subPath = pageId
      if (subPath === '/') {
        // import("@!virtual-modules/pages/") would make vite confused
        // so we change the sub path
        subPath = '/__index'
      }
      const code = `
pages["${pageId}"] = {};
import page${index} from "@!virtual-modules/pages${subPath}";
pages["${pageId}"] = page${index};`
      return code
    }
  )
  return `
const pages = {};
${addPagesData.join('\n')}
export default pages;
`
}

export function renderOnePageData(onePageData: { [dataKey: string]: string }) {
  const importModule = Object.entries(onePageData).map(
    ([dataKey, path], idx) => `
import * as m${idx} from "${slash(path)}";
modules["${dataKey}"] = m${idx};`
  )
  return `
  const modules = {};
  ${importModule.join('\n')}
  export default modules;`
}

export async function extractStaticData(
  fileContent: string,
  extname: string
): Promise<{ sourceType: string; [key: string]: any }> {
  switch (extname) {
    case 'md':
    case 'mdx':
      const { data: frontmatter } = grayMatter(fileContent)
      return { ...frontmatter, sourceType: 'md' }
    case 'js':
    case 'jsx':
    case 'ts':
    case 'tsx':
      return { ...parse(extract(fileContent)), sourceType: 'js' }
    default:
      throw new Error(`unexpected extension name "${extname}"`)
  }
}

function createFindPagesContext(): [FindPagesResult, FindPagesHelpers] {
  const result: FindPagesResult = {}

  const readFileCache: { [filePath: string]: Promise<string> } = {}
  const readFileWithCache = async (filePath: string) => {
    if (readFileCache[filePath]) return readFileCache[filePath]
    readFileCache[filePath] = fs.readFile(filePath, 'utf-8')
    return readFileCache[filePath]
  }
  const extractStaticDataWithCache = async (filePath: string) =>
    extractStaticData(
      await readFileWithCache(filePath),
      path.extname(filePath).slice(1)
    )
  const defaultFindPages = (baseDir: string) =>
    _defaultFindPages(baseDir, helpers)

  const addPageData = (pageData: PageData) => {
    if (!pageData.pageId.startsWith('/')) {
      throw new Error(
        `addPageData error: pageId should starts with "/", but got "${pageData.pageId}"`
      )
    }
    let exist = result[pageData.pageId]
    if (!exist) {
      exist = result[pageData.pageId] = {
        data: {},
        staticData: {},
      }
    }
    const key = pageData.key ?? 'main'
    if (pageData.dataPath) {
      if (exist.data[key]) {
        throw new Error(
          `addPageData conflict: data with key "${key}" already exist. Please give this data another key.`
        )
      }
      exist.data[key] = pageData.dataPath
    }
    if (pageData.staticData) {
      if (exist.staticData[key]) {
        throw new Error(
          `addPageData conflict: staticData with key "${key}" already exist. Please give this staticData another key.`
        )
      }
      exist.staticData[key] = pageData.staticData
    }
  }

  const helpers: FindPagesHelpers = {
    readFile: readFileWithCache,
    extractStaticData: extractStaticDataWithCache,
    globFind,
    defaultFindPages,
    addPageData,
  }
  return [result, helpers]
}

export interface FindPagesResult {
  readonly [pageId: string]: {
    readonly data: {
      readonly [key: string]: string
    }
    readonly staticData: {
      readonly [key: string]: any
    }
  }
}
