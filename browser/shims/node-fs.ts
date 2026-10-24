/**
 * node:fs stand-in for the browser bundle. Server modules import fs but only
 * call it on code paths the browser edition never takes (file databases,
 * migration directories, serving the built client); existsSync reports
 * "nothing on disk" and every other call fails loudly.
 */
const unavailable = (name: string) =>
  function (..._args: unknown[]): never {
    throw new Error(`Not available in the browser edition (fs.${name})`);
  };

export const existsSync = (_path: unknown): boolean => false;
export const readFileSync = unavailable('readFileSync');
export const writeFileSync = unavailable('writeFileSync');
export const mkdirSync = unavailable('mkdirSync');
export const readdirSync = unavailable('readdirSync');
export const cpSync = unavailable('cpSync');
export const rmSync = unavailable('rmSync');
export const statSync = unavailable('statSync');
export const copyFileSync = unavailable('copyFileSync');
export const renameSync = unavailable('renameSync');
export const unlinkSync = unavailable('unlinkSync');

export default {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  cpSync,
  rmSync,
  statSync,
  copyFileSync,
  renameSync,
  unlinkSync,
};
