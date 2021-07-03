#!/usr/bin/env node
const acorn = require('acorn');
const fs = require('fs');
const assert = require("assert");
const path = require('path');
const inquirer = require('inquirer');
const args = require('minimist')(process.argv.slice(2));
const convertToIntegerKey = require('./utils/convertToIntegerKey');

const _getModuleLocation = require('./utils/getModuleLocation');
var get_node_code = require('./utils/get_node_code');
const setFileExt = _getModuleLocation.setFileExt

// ----------------------------------------------------------------------------
// Set up configuration
// ----------------------------------------------------------------------------

const bundleLocation = args._[0] || args.input || args.i;
const outputLocation = args.output || args.o;
const configPath = args.config || args.c;
const logLevel = args.log || args.l || 'log';
const configTest = args.config_test || args.t || false;

if (!(bundleLocation && outputLocation && configPath)) {
    console.log(`This is a debundler - it takes a bundle and expands it into the source that was used to compile it.`);
    console.log();
    console.log(`Usage: ${process.argv[1]} [input file] {OPTIONS}`);
    console.log();
    console.log(`Options:`);
    console.log(`   --input,  -i  Bundle to debundle`);
    console.log(`   --output, -o  Directory to debundle code into.`);
    console.log(`   --config, -c  Configuration directory`);
    console.log(`   --log, -l  Log level: log > debug `);
    console.log(`   --config_test, -t  only parse Configuration file `);
    console.log();
    process.exit(1);
}

const config = JSON.parse(fs.readFileSync(args.config || args.c));

if (config.knownPaths) {
    config.knownPaths = convertToIntegerKey(config.knownPaths);
} else {
    throw new Error('config.knownPaths is a required parameter that indicated known paths to a module given its id.');
}

if (!config.moduleAst) {
    if (config.type === 'browserify') {
        // Where browserify defaultly stores all it's embedded modules as an object
        config.moduleAst = ["body", 0, "expression", "arguments", 0];
    } else if (config.type === 'webpack') {
        // Where webpack defaultly stores all it's embedded modules as an array
        // config.moduleAst = ["body", 0, "expression", "arguments", 0];
        // from:  hectorqin /debundle
        config.moduleAst = ["body", 0, "expression", "argument", "arguments", 0];
    }
    console.log(`* Using default AST location for ${config.type}...`);
}


config.fileExt = typeof config.fileExt === 'undefined' ? null : config.fileExt;
if (config.fileExt) {
    setFileExt(config.fileExt)
}

config.replaceRequires = typeof config.replaceRequires === 'undefined' ? "inline" : config.replaceRequires;
config.replaceModules = typeof config.replaceModules === 'undefined' ? "inline" : config.replaceModules;
config.replaceExports = typeof config.replaceExports === 'undefined' ? "inline" : config.replaceExports;
config.variableType = config.variableType !== 'var' ? "const" : 'var';

config.keepDeeperThan = typeof config.keepDeeperThan === 'undefined' ? 999 : parseInt(config.keepDeeperThan);
config.keepArgumentsDeeperThan = typeof config.keepArgumentsDeeperThan === 'undefined' ? 1 : parseInt(config.keepArgumentsDeeperThan);

if (typeof config.inDescendantsOfSameNameDeclaraton === 'undefined')
    config.inDescendantsOfSameNameDeclaraton = 'replace'
else if (!['keep', 'replace', 'ask'].includes(config.inDescendantsOfSameNameDeclaraton))
    config.inDescendantsOfSameNameDeclaraton = 'ask'


if (config.replaceResultString) {
    // assert(true, config.replaceResultString instanceof Array)
    if (!config.replaceResultString instanceof Array) {
        config.replaceResultString = [configf.replaceResultString]
    }
    for (let replaceResultString of config.replaceResultString) {
        assert(true,
            'from' in replaceResultString &&
            'to' in replaceResultString
        )

        // 'all' is only for regexp
        if (!('all' in replaceResultString))
            replaceResultString.all = true

        if (replaceResultString.regexp) {
            replaceResultString.from = new RegExp(replaceResultString.from, replaceResultString.all ? 'gm' : '')
        }
    }
}


function prepareObjects(type, config_name) {
    config[`${type}_objects`] = [];
    if (config[config_name]) {
        for (const [name, props] of Object.entries(config[config_name])) {
            console.log(`${type}: ${name}`)
            if (!(props.enable && fs.existsSync(path.resolve(__dirname, `${type}s/${name}.js`)))) {
                console.log(`  ${type} ${name} not enabled`)
            }else{
                console.log(`  require(./${type}s/${name})(props,config) `)
                config[`${type}_objects`].push(require(`./${type}s/${name}`)(props, config))
            }
        }
    }
}

prepareObjects('require_visitor', 'require_visitors')
prepareObjects('visitor', 'other_visitors')
prepareObjects('filter', 'filters')


if(configTest) {
    console.log('\n\n\ntest finished!')
    return
}

// ----------------------------------------------------------------------------
// Read in bundle
// ----------------------------------------------------------------------------

console.log('* Reading bundle...');
const bundleContents = fs.readFileSync(bundleLocation);

let ast = acorn.parse(bundleContents, {});

// Get the entry point in the bundle.
if (config.type === 'browserify' && !config.entryPoint) {
    console.log('* Using auto-discovered browserify entry point...');
    config.entryPoint = ast.body[0].expression.arguments[2].elements[0].value;
}

if (config.entryPoint === undefined) {
    throw new Error('config.entryPoint is a required parameter that indicated the entry point in the bundle.');
}


// ----------------------------------------------------------------------------
// Find all the modules in the bundle via `moduleAst`
// ----------------------------------------------------------------------------

let iifeModules = ast;
let moduleAstPathTriedSoFar = [];
while (true) {
    let operation = config.moduleAst.shift();

    if (logLevel == 'debug') {
        console.log(operation)
        console.log(iifeModules)
    }

    if (!iifeModules) {
        throw new Error(`Locating the module AST failed. Please specifify a valid manual ast path in your config file with the key \`moduleAst\`. We got as far as ${moduleAstPathTriedSoFar.join('.')} before an error occured.`);
    } else if (operation === undefined) {
        break;
    } else {
        iifeModules = iifeModules[operation];
        moduleAstPathTriedSoFar.push(operation);
    }
}

// ------------------------------------------------------------------------------
// Given the path to the modules in the AST and the AST, pull out the modules and normalize
// them to a predefined format.
// ------------------------------------------------------------------------------

console.log('* Decoding modules...');

let modules;
if (config.type === 'browserify') {
    // Normalize all require function calls to all contain the module id.
    // var a = require('a') => var a = require(1)
    const browserifyDecoder = require('./decoders/browserify');
    modules = browserifyDecoder(iifeModules);
} else {
    const webpackDecoder = require('./decoders/webpack');
    modules = webpackDecoder(iifeModules, config.knownPaths);
}


// ------------------------------------------------------------------------------
// Transform the module id in each require call into a relative path to the module.
// var a = require(1) => var a = require('./path/to/a')
// ------------------------------------------------------------------------------

console.log('* Reassembling requires...');
const transformRequires = require('./transformRequires');
modules = transformRequires(modules,
    config);

// ------------------------------------------------------------------------------
// Take the array of modules and figure out where to put each module on disk.
// module 1 => ./dist/path/to/a.js
// ------------------------------------------------------------------------------

console.log('* Resolving files...');
const lookupTableResolver = require('./lookupTable');
const codesOfFiles = lookupTableResolver(
    modules,
    config.knownPaths,
    config.entryPoint,
    config.type,
    outputLocation
);

// ------------------------------------------------------------------------------
// Finally, write the bundle to disk in the specified output location.
// ------------------------------------------------------------------------------

console.log('* Writing to disk...');
const writeToDisk = require('./writeToDisk');
writeToDisk(codesOfFiles, config);
