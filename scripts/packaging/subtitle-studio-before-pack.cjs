const { pathToFileURL } = require('node:url');
const path = require('node:path');

function createBeforePackHook(dependencies = {}) {
  return async function subtitleStudioBeforePack(context) {
    const contract = await import(pathToFileURL(path.join(__dirname, 'subtitle-studio-contract.mjs')).href);
    const target = contract.resolvePackagingTarget(context, dependencies.host);
    const projectRoot = context?.packager?.info?.projectDir;
    // This is electron-builder's actual complete resolved configuration.
    contract.assertPackagingConfig(context?.packager?.config);
    const report = await contract.verifyPackagingContributions({ projectRoot, target }, dependencies);
    if (target.platform !== 'win32') return report;
    // Windows ships Microsoft's VC++ redistributable; an unverifiable one refuses the build.
    const prepareVcRedist = dependencies.prepareVcRedist
      ?? (await import(pathToFileURL(path.join(__dirname, 'vc-redist.mjs')).href)).prepareVcRedist;
    let vcRedist;
    try { vcRedist = await prepareVcRedist({ projectRoot, log: message => console.log(`  - vc-redist: ${message}`) }); }
    catch (cause) { throw contract.packagingError('The VC++ redistributable failed verification.', 'vc-redist', cause); }
    return { ...report, vcRedist };
  };
}

module.exports = createBeforePackHook();
module.exports.createBeforePackHook = createBeforePackHook;
