// Boot probe: import all top-level modules in the same order index.js does,
// to make sure no import errors / circular deps / missing exports.
process.chdir('/mnt/c/Users/Prism/SnipeTrenchBot');
process.env.DRY_RUN = 'true';
process.env.TELEGRAM_BOT_TOKEN = 'smoke...';
process.env.TELEGRAM_CHAT_ID = '000';
process.env.HELIUS_API_KEY = 'smoke';

(async () => {
  const mods = [
    '../src/config.js',
    '../src/db.js',
    '../src/settings.js',
    '../src/settingsMenu.js',
    '../src/filters.js',
    '../src/jupiterMetis.js',
    '../src/safety.js',
    '../src/heliusMonitor.js',
    '../src/executor.js',
    '../src/notifier.js',
    '../src/telegramBot.js',
  ];
  for (const m of mods) {
    try {
      const start = Date.now();
      const mod = await import(m);
      const ms = Date.now() - start;
      const exports = Object.keys(mod).sort().join(', ');
      console.log(`  ✅ ${m} (${ms}ms) [${exports.slice(0, 60)}${exports.length > 60 ? '…' : ''}]`);
    } catch (err) {
      console.log(`  ❌ ${m}: ${err.message}`);
      console.log(err.stack);
      process.exit(1);
    }
  }
  console.log('\nAll modules import cleanly. Boot path is safe.');
  process.exit(0);
})();
