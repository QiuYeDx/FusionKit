const { pathToFileURL } = require('node:url');
const path = require('node:path');

function createBeforePackHook(dependencies = {}) {
  return async function subtitleStudioBeforePack(context) {
    const contract = await import(pathToFileURL(path.join(__dirname, 'subtitle-studio-contract.mjs')).href);
    const target = contract.resolvePackagingTarget(context, dependencies.host);
    const projectRoot = context?.packager?.info?.projectDir;
    // This is electron-builder's actual complete resolved configuration.
    contract.assertPackagingConfig(context?.packager?.config);
    return contract.verifyPackagingContributions({ projectRoot, target }, dependencies);
  };
}

module.exports = createBeforePackHook();
module.exports.createBeforePackHook = createBeforePackHook;
