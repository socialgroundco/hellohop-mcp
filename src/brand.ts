// The ONE place the product's name and domain live.
//
// The package name is settled; the domain is not. Every public string that would
// name the product (the package name, the MCP server name, tool descriptions)
// reads from here, so a rename is a one-line change.
//
// package.json `name` must equal BRAND.packageName, and the MCP server must be
// constructed with it. test/brand.test.ts asserts both.
//
// NOT SHARED WITH THE CONSOLE, deliberately. console/src/lib/brand.ts is the
// console's own constant and carries the working product name; this package is
// a separate npm package with no shared module, and nothing cross-checks the
// two. test/brand.test.ts refuses that working name anywhere in this package,
// so adopting the settled brand here is a change to this file AND that test,
// made on purpose, never a drift.
export const BRAND = {
  packageName: 'hellohop-mcp',
  // The command npm installs for this package.
  binName: 'hellohop-mcp',
  // Used in prose, for example tool descriptions. Deliberately generic.
  productName: 'the gateway',
  // The public API base, used when GATEWAY_API_URL is unset. Mirrors
  // BRAND.apiOrigin + /v1 in console/src/lib/brand.ts (not shared, see above).
  publicApiUrl: 'https://api.hellohop.app/v1',
  // The official MCP Registry name; package.json `mcpName` must equal it.
  mcpName: 'app.hellohop/hellohop',
  // The product site.
  siteUrl: 'https://hellohop.app',
  // The public docs page for this package (the console route /docs/mcp).
  docsUrl: 'https://hellohop.app/docs/mcp',
} as const;

// Must equal package.json `version` (asserted in test/brand.test.ts).
export const SERVER_VERSION = '0.3.2';
