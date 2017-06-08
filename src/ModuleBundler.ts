import * as Bluebird from 'bluebird';
import { join, sep } from 'path';
import * as resolvePackage from 'resolve-pkg';

import { Archiver } from 'archiver';
import { exists } from 'fs-extra';
import { Logger } from './lib/Logger';
import { handleFile } from './lib/utils';
import { Walker } from './lib/Walker';
import { UglifyTransform } from './transforms/Uglify';

export interface IModule {
  packagePath: string;
  relativePath: string;
  packageJson: any;
  packageDir: string;
}

export type IUglifyParams = null | boolean | { [key: string]: any };

/**
 *  @class ModuleBundler
 *
 *  Handles the inclusion of node_modules.
 */
export class ModuleBundler {
  modules: IModule[];

  logger: Logger;
  archive: Archiver;
  servicePath: string;
  uglify: IUglifyParams;
  followSymlinks: boolean = true;

  constructor (config: {
    logger: Logger;
    archive: Archiver;
    servicePath: string;
    uglify?: IUglifyParams;
    followSymlinks?: boolean;
  }) {
    Object.assign(this, config);
  }

  /**
   *  Determines module locations then adds them into ./node_modules
   *  inside the artifact.
   */
  async bundle ({ include = [], exclude = [], deepExclude = [] }: {
    include?: string[], exclude?: string[], deepExclude?: string[],
  }) {
    this.modules = await this.resolveDependencies(
      this.servicePath,
      { include, exclude, deepExclude },
    );

    const transforms = await this.resolveTransforms();

    const readModule = async ({ packagePath, packageDir, relativePath, packageJson }) => {
      const filter = (dirPath, stats) => {
        if (walker.symlinkRoots.has(dirPath)) { console.log('wew', dirPath);}

        // This pulls ['node_modules', 'pack'] out of
        // .../node_modules/package/node_modules/pack
        const endParts = dirPath.split(packagePath)[1].split('/').slice(-2);

        // When a directory is a package and matches a deep exclude pattern
        // Then skip it
        if (
          endParts[0] === 'node_modules' &&
          deepExclude.indexOf(endParts[1]) !== -1
        ) {
          return false;
        }

        return true;
      };

      const onFile = async (filePath, stats) => {
        const relPath = filePath.substr(filePath.indexOf(relativePath)).replace(/^\/|\/$/g, '');

        // if (/lutils/.test(filePath)) console.log(filePath);
        await handleFile({
          filePath,
          relPath,
          transforms,
          transformExtensions: ['js', 'jsx'],
          useSourceMaps: false,
          archive: this.archive,
        });
      };

      console.log({ packagePath, packageDir });

      // TODO: to solve symlinks we need the package resolver to return the original path
      // - option 1: traverse at depth 2 all folders beforehand, building up a list of symlinks & their resolved paths, then use that to fudge a new path
      // - options 2: see if the module has symlink related functionality

      const walker = new Walker(packagePath, { followSymlinks: this.followSymlinks })
        .filter(filter)
        .file(onFile);

      await walker.end();

      await this.logger.module(({ filePath: relativePath, packageJson }));
    };

    await Bluebird.map(this.modules, readModule);

    return this;
  }

  private async resolveTransforms () {
    const transforms = [];

    let uglifyConfig = this.uglify;

    if (uglifyConfig) {
      if (uglifyConfig === true) { uglifyConfig = null; }

      transforms.push(new UglifyTransform(uglifyConfig, this));
    }

    return transforms;
  }

  /**
   * Resolves a package's dependencies to an array of paths.
   */
  private async resolveDependencies (
    initialPackageDir,
    { include = [], exclude = [], deepExclude = [] } = {},
  ): Promise<IModule[]> {
    const resolvedDeps: IModule[] = [];
    const cache: Set<string> = new Set();
    const separator = `${sep}node_modules${sep}`;

    /**
     *  Resolves packages to their package root directory &
     *  also resolves dependant packages recursively.
     *  - Will also ignore the input package in the results
     */
    const recurse = async (packageDir, _include = [], _exclude = []) => {
      const packageJson = require(join(packageDir, './package.json')); // eslint-disable-line
      const { name, dependencies } = packageJson;

      const result = {
        name,
        packageDir,
        packagePath: packageDir,
      };

      if (!dependencies) { return result; }

      await Bluebird.map(Object.keys(dependencies), async (packageName) => {
        /**
         *  Skips on exclude matches, if set
         *  Skips on include mis-matches, if set
         */
        if (_exclude.length && _exclude.indexOf(packageName) > -1) { return; }
        if (_include.length && _include.indexOf(packageName) < 0) { return; }

        const resolvedDir = resolvePackage(packageName, { cwd: packageDir });

        const childPackageJsonPath = join(resolvedDir, './package.json');

        let childPackageJson;
        if (await exists(childPackageJsonPath)) {
          childPackageJson = require(childPackageJsonPath); // eslint-disable-line
        }

        if (!resolvedDir) { return; }

        const relativePath = join('node_modules', resolvedDir.split(separator).slice(1).join(separator));

        if (cache.has(relativePath)) { return; }

        cache.add(relativePath);

        const childResult = await recurse(resolvedDir, undefined, deepExclude);

        resolvedDeps.push({ ...childResult, packageDir, relativePath, packageJson: childPackageJson });
      });

      return result;
    };

    await recurse(initialPackageDir, include, exclude);

    return resolvedDeps;
  }
}
