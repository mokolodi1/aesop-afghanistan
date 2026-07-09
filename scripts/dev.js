// Dev mode: bundle the client with esbuild in watch mode (rebuilds on every
// change to src/client/) and run the server with auto-restart on server-side
// changes. public/app.js and public/app.css are generated output — never edit
// or commit them; src/client/ is the source of truth.
const { spawn } = require('child_process');
const esbuild = require('esbuild');

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/client/app.jsx'],
    bundle: true,
    sourcemap: true,
    outfile: 'public/app.js',
    logLevel: 'info',
  });

  // Fail fast and guarantee a fresh bundle exists before the server starts.
  await ctx.rebuild();
  await ctx.watch();

  const server = spawn(process.execPath, ['--watch', '--watch-preserve-output', 'server.js'], {
    stdio: 'inherit',
    env: { ...process.env, PORT: process.env.PORT || '3003' },
  });

  server.on('exit', async (code) => {
    await ctx.dispose();
    process.exit(code ?? 0);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.kill(signal));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
