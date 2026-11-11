export {};
const name = 'synthetic-test-' + crypto.randomUUID();
const value = crypto.randomUUID();
try {
  await Bun.secrets.set({ service: 'costly', name, value, persist: 'local' });
  if (await Bun.secrets.get({ service: 'costly', name }) !== value) throw new Error('Keychain round trip failed.');
  console.log('OS keychain write/read passed; synthetic credential removed.');
} finally { await Bun.secrets.delete({ service: 'costly', name }); }
