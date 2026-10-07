const path = require("node:path");
const loaded = require("mocha");
const Mocha = loaded.default ?? loaded;

exports.run = async function run() {
  const mocha = new Mocha({ ui: "bdd", color: true, timeout: 120000 });
  mocha.addFile(path.join(__dirname, "extension.test.js"));
  await new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} tests failed`)) : resolve()));
  });
};
