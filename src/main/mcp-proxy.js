'use strict';
// mcp-remote's proxy for one of Tandem's servers, named by the one argument.
// The header values come from ~/.tandem/mcp.json by way of the environment, so
// no token is ever on a command line. See launchList in mcp-registry.js.
const { pathToFileURL } = require('url');
const { proxyLaunch } = require('./mcp-registry');

const { entry, args, env } = proxyLaunch(process.argv[2]);
Object.assign(process.env, env);
process.argv = [process.argv[0], entry, ...args];
import(pathToFileURL(entry).href);
