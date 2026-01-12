module.exports = {
  appId: 'co.brilliantai.brilliantcode',
  productName: 'BrilliantCode',
  artifactName: 'brilliantcode-open-${version}-${arch}.${ext}',
  directories: {
    output: 'release',
    buildResources: 'resources'
  },
  files: [
    'dist/**/*',
    '!dist/cli/**',
    'package.json'
  ],
  protocols: [
    {
      name: 'BrilliantCode Deep Link',
      schemes: ['brilliantcode']
    }
  ],
  // Auto-update configuration (optional; set `BRILLIANTCODE_PUBLISH_URL` to enable)
  publish: process.env.BRILLIANTCODE_PUBLISH_URL
    ? { provider: 'generic', url: process.env.BRILLIANTCODE_PUBLISH_URL }
    : undefined,
  mac: {
    category: 'public.app-category.developer-tools',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    target: ['dmg', 'zip'],
    icon: 'resources/BrilliantCode.icns'
  },
  dmg: {
    icon: 'resources/BrilliantCode.icns'
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64', 'arm64'] }],
    artifactName: 'brilliantcode-open-${version}-${arch}.${ext}'
  },
  linux: {
    target: [
      { target: 'AppImage', arch: ['x64', 'arm64'] },
      { target: 'deb', arch: ['x64', 'arm64'] },
      { target: 'rpm', arch: ['x64', 'arm64'] },
    ],
    category: 'Utility',
    maintainer: 'Brilliant AI Technologies Ltd'
  }
};
