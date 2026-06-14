/**
 * Jamulus client invocation. --nogui because the container has no desktop;
 * the client reads from the ALSA loopback capture end, which carries the
 * browser's Strudel output plus the ffmpeg bed. Argv array for spawn(), same
 * rationale as ffmpeg-bed.
 */

// Jamulus registers with JACK as "Jamulus <clientname>", and JACK caps
// client names at 33 chars — 8 are spent on the prefix, so anything longer
// than 25 makes Jamulus exit ("...is too long to be used as a JACK client
// name"). Long dog breeds (Petit Basset Griffon Vendeen) hit this.
const MAX_CLIENT_NAME = 25;

export function jamulusArgs({ server, name, iniFile, clientArgs = [] }) {
  if (!server || !name) throw new TypeError('server and name are required');
  return [
    '--nogui',
    '--connect', server,
    '--clientname', name.slice(0, MAX_CLIENT_NAME),
    ...(iniFile ? ['--inifile', iniFile] : []),
    ...clientArgs,
  ];
}

// Generates the content of a Jamulus ini file that sets the musician name
// shown in the mixer. --clientname only sets the JACK/window name; the
// mixer display name comes from the [client] Name key in the ini file.
export function jamulusIniContent(name) {
  return `[client]\nName=${name}\n`;
}
