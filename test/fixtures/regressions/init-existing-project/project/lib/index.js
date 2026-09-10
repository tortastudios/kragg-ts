// A CommonJS project, in the only way that is not a matter of opinion: it
// uses `require` and `module.exports`, and `package.json` has no `type` field.
// Adding `"type": "module"` to this package makes this file fail to load.
const { basename } = require("node:path");

function slugify(value) {
  return String(value).trim().toLowerCase().replaceAll(" ", "-");
}

function slugifyPath(value) {
  return slugify(basename(value));
}

module.exports = { slugify, slugifyPath };
