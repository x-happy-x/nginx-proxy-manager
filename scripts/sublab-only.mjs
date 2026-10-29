// NPM-102: offline migration; live validation and reload belong to the operator.
export function sublabOnly(original, routing, sublab) {
  const config = structuredClone(original);
  const settings = structuredClone(routing);
  const state = structuredClone(sublab);
  const providers = config['proxy-providers'];
  const managed = state.managed.filter(p => p.nodes > 0 && providers[p.provider]);
  if (!managed.length) throw new Error('No active Sub Lab subscriptions');
  const sources = new Set(managed.map(p => p.provider));
  for (const p of managed) {
    if (!p.provider.startsWith('SL-') || providers[p.provider].type !== 'file' ||
        providers[p.provider].path !== p.path) {
      throw new Error('Sub Lab state does not match the active configuration');
    }
  }
  const removed = [];
  for (const name of Object.keys(providers)) {
    // OLCRTC is a separately managed transport, not a subscription.
    if (sources.has(name) || name === 'olcrtc') continue;
    if (!['ROUTER', 'CHAIN', 'AI'].includes(name)) {
      throw new Error(`Unexpected provider: ${name}`);
    }
    removed.push(name);
    delete providers[name];
  }
  const removedGroups = new Set(['Каскад']);
  config['proxy-groups'] = config['proxy-groups'].filter(g => !removedGroups.has(g.name));
  for (const g of config['proxy-groups']) {
    if (g.use) {
      g.use = [...new Set(g.use.flatMap(p => removed.includes(p) ? [...sources] : [p]))];
      if (!g.use.length) delete g.use;
    }
    if (g.proxies) g.proxies = g.proxies.filter(p => !removedGroups.has(p));
  }
  const names = new Set(config['proxy-groups'].map(g => g.name));
  for (const g of config['proxy-groups']) {
    for (const p of g.use || []) {
      if (!providers[p]) throw new Error(`Unknown provider in group: ${g.name}`);
    }
    if (!(g.use?.length || g.proxies?.length)) throw new Error(`Empty group: ${g.name}`);
  }
  const refersToCascade = value => {
    if (Array.isArray(value)) return value.some(refersToCascade);
    if (value && typeof value === 'object') return Object.values(value).some(refersToCascade);
    return typeof value === 'string' && value.split(',').some(p => p.trim() === 'Каскад');
  };
  if (refersToCascade(config)) throw new Error('A cascade reference still exists');
  // Keep the routing form usable; later Apply must not recreate the old source.
  if (!sources.has(settings.base)) {
    settings.base = [...managed].sort((a, b) => b.nodes - a.nodes)[0].provider;
  }
  settings.cascade = false;
  for (const key of ['groups', 'applied_groups']) {
    state[key] = (state[key] || []).filter(name => names.has(name));
  }
  return { config, routing: settings, sublab: state, summary: {
    removedProviders: removed,
    subscriptions: managed.map(p => ({ name: p.title, provider: p.provider, nodes: p.nodes })),
    base: settings.base,
    cascade: false,
    preservedTransports: [providers.olcrtc && 'OLCRTC',
      config.proxies?.some(p => p.type === 'tailscale') && 'Tailscale'].filter(Boolean),
  } };
}
