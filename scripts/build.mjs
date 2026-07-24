import { transformAsync } from "@babel/core"
import presetTypeScript from "@babel/preset-typescript"
import { execFileSync } from "node:child_process"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, extname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const sourceRoot = join(root, "src")
const outputRoot = join(root, "dist")

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return sourceFiles(path)
      if (!entry.isFile() || entry.name.endsWith(".d.ts")) return []
      return [".ts", ".tsx"].includes(extname(entry.name)) ? [path] : []
    }),
  )
  return nested.flat()
}

async function transformSource(path) {
  const isTsx = extname(path) === ".tsx"
  const presets = [[presetTypeScript, { allExtensions: true, isTSX: isTsx }]]
  const result = await transformAsync(await readFile(path, "utf8"), {
    filename: path,
    babelrc: false,
    configFile: false,
    presets,
    sourceMaps: false,
  })

  if (typeof result?.code !== "string") {
    throw new Error(`Babel produced no JavaScript for ${relative(root, path)}`)
  }

  const outputPath = join(
    outputRoot,
    `${relative(sourceRoot, path).replace(/\.tsx?$/, "")}.js`,
  )
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${result.code}\n`, "utf8")
}

async function build() {
  await rm(outputRoot, { recursive: true, force: true })

  const tsc = require.resolve("typescript/bin/tsc")
  execFileSync(
    process.execPath,
    [tsc, "-p", join(root, "tsconfig.json"), "--emitDeclarationOnly"],
    { cwd: root, stdio: "inherit" },
  )

  const files = await sourceFiles(sourceRoot)
  await Promise.all(files.map(transformSource))
}

await build()
