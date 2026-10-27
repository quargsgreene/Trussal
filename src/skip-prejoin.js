// skip-prejoin.js — `href` with Jitsi's prejoin ("Join meeting") screen
// turned off through its #config URL overrides, any other overrides kept.
// Used wherever this app sends a performer into a meeting on their behalf:
// a meeting() move (meeting-move-core.js) and the panic button
// (panic-button.js), neither of which should leave them waiting on a click.
//
// Import-free and side-effect-free, so panic-button.js can still load before
// anything else.

const PARAM = 'config.prejoinConfig.enabled';

export function skipPrejoin(href) {
  const url = new URL(href);
  const params = url.hash.replace(/^#/, '').split('&').filter((p) => p && !p.startsWith(`${PARAM}=`));
  url.hash = [...params, `${PARAM}=false`].join('&');
  return url.toString();
}
