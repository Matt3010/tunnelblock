// TunnelBlock control panel. Plain DOM building (no innerHTML) keeps every
// server value as text, and the page works under a strict CSP.

const view = document.getElementById("view");
const toastEl = document.getElementById("toast");

// ---- Helpers --------------------------------------------------------------

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

// Relative to the bare origin: a page opened as http://user:pass@host/ would
// otherwise make every fetch() throw.
const url = path => new URL(path, location.origin);

async function api(method, path, body) {
  const res = await fetch(url(path), {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data;
}

let toastTimer;
function toast(message, error = false) {
  toastEl.textContent = message;
  toastEl.className = error ? "error" : "";
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, error ? 6000 : 2500);
}

/** Button that disables itself while its action runs and reports failures. */
function action(label, run, props = {}) {
  const button = h("button", { type: "button", ...props }, label);
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await run();
    } catch (error) {
      toast(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

function confirmAction(label, question, run, props = {}) {
  return action(label, async () => {
    if (window.confirm(question)) await run();
  }, props);
}

const count = value => new Intl.NumberFormat("en-US").format(Number(value ?? 0) || 0);

function bytes(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  return `${(n / 1024 ** 3).toFixed(2)} GiB`;
}

function duration(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds ?? 0)));
  const d = Math.floor(s / 86400);
  const hr = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${hr}h`;
  if (hr) return `${hr}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}

const date = value => (value ? new Date(value).toLocaleString() : "never");

function shortListName(value) {
  try {
    const url = new URL(value);
    const tail = url.pathname.split("/").filter(Boolean).pop();
    return tail ? `${url.hostname}/${tail}` : url.hostname;
  } catch {
    return value;
  }
}

function stateClass(state) {
  const value = String(state ?? "").toLowerCase();
  if (["healthy", "running", "success", "ready"].includes(value)) return "ok";
  if (["failed", "error", "unhealthy", "missing", "exited"].includes(value)) return "bad";
  if (["stopped", "idle", "inactive"].includes(value)) return "muted";
  return "warn";
}

const stat = (label, value) => h("div", { class: "stat" }, h("div", { class: "label" }, label), h("div", { class: "value" }, value));
const card = (...children) => h("div", { class: "card" }, ...children);
const back = (href, label) => h("div", { class: "back" }, h("a", { href }, `← ${label}`));

function row({ title, sub, right, onclick }) {
  return h("div", { class: onclick ? "row clickable" : "row", onclick },
    h("div", { class: "main" }, h("div", { class: "title" }, title), sub ? h("div", { class: "sub" }, sub) : null),
    right ?? null);
}

function download(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = h("a", { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- Overview -------------------------------------------------------------

async function overviewPage() {
  const [status, diag, blocked, allowed] = await Promise.all([
    api("GET", "/api/status").catch(error => ({ error: error.message })),
    api("GET", "/api/diag"),
    api("GET", "/api/top?decision=block").catch(() => ({ items: [] })),
    api("GET", "/api/top?decision=allow").catch(() => ({ items: [] })),
  ]);
  const update = diag.updater.ok ? diag.updater.body : null;
  if (update?.running) {
    setTimeout(() => { if (["", "#/", "#/overview"].includes(location.hash)) route(); }, 5000);
  }

  const services = update?.services ?? {};
  const serviceRows = [
    ["DNS resolver A", services.dohA],
    ["DNS resolver B", services.dohB],
    ["WireGuard", services.wireguard],
    ["Web panel", services.web],
    ["HTTPS proxy", services.httpsProxy ?? "stopped"],
  ].map(([name, state]) => row({ title: name, right: h("span", { class: `chip ${stateClass(state)}` }, state ?? "unknown") }));

  const topList = (title, data) => card(
    h("h2", {}, title),
    (data.items ?? []).length
      ? (data.items ?? []).slice(0, 10).map((item, index) => row({
          title: `${index + 1}. ${item.domain}`,
          sub: item.matchedRule && item.matchedRule !== item.domain ? `rule ${item.matchedRule}` : null,
          right: h("span", { class: "chip" }, count(item.count)),
        }))
      : h("p", { class: "muted" }, "No data yet."),
  );

  return [
    h("h1", {}, "Overview"),
    status.error
      ? card(h("p", { class: "bad" }, `Resolver unreachable: ${status.error}`))
      : card(
          h("div", { class: "grid" },
            stat("Resolver", status.ok ? "Online" : "Offline"),
            stat("Uptime", duration(status.uptimeSec)),
            stat("Queries", count(status.queries)),
            stat("Blocked", `${count(status.blocked)} (${status.blockRate ?? 0}%)`),
            stat("Active blocklists", count(status.blocklists)),
            stat("Blocked domains", count(status.externalBlockedDomains)),
          ),
          Number(status.blocklistErrors) ? h("p", { class: "warn" }, `${count(status.blocklistErrors)} blocklist(s) report errors.`) : null,
        ),
    updateCard(update, diag.updater.ok ? null : diag.updater.body?.error),
    card(h("h2", {}, "Services"), serviceRows,
      h("p", { class: "sub muted" },
        `Resolver health: ${diag.health.ok ? "OK" : "failing"} · storage: ${diag.ready.body?.statsStorage ?? (diag.ready.ok ? "OK" : "failing")}`)),
    topList("🚫 Most blocked", blocked),
    topList("✅ Most requested", allowed),
  ];
}

function updateCard(update, error) {
  if (!update) return card(h("h2", {}, "Updates"), h("p", { class: "bad" }, `Updater unreachable: ${error ?? "unknown error"}`));

  const state = update.running ? "updating" : update.lastSuccess === true ? "success" : update.lastSuccess === false ? "failed" : "idle";
  const output = String(update.lastOutput ?? "").slice(-6000);

  return card(
    h("h2", {}, "Updates"),
    h("dl", {},
      h("dt", {}, "State"), h("dd", {}, h("span", { class: `chip ${stateClass(state)}` }, state)),
      h("dt", {}, "Version"), h("dd", {}, h("code", {}, String(update.currentSha ?? "-").slice(0, 8))),
      h("dt", {}, "Last started"), h("dd", {}, date(update.lastStartedAt)),
      h("dt", {}, "Last finished"), h("dd", {}, date(update.lastFinishedAt)),
    ),
    state === "failed" ? h("p", { class: "bad" }, "The last update failed and was rolled back. See the log below.") : null,
    h("div", { class: "actions" },
      action("🔄 Update now", async () => {
        await api("POST", "/api/update", {});
        toast("Update started");
        route();
      }, { class: "primary", disabled: update.running }),
      action("♻️ Reload DNS rules", async () => {
        await api("POST", "/api/reload", {});
        toast("DNS rules reloaded");
      }),
    ),
    output ? h("details", { open: update.running || state === "failed" }, h("summary", {}, "Latest log"), h("pre", {}, output)) : null,
  );
}

// ---- Domains --------------------------------------------------------------

const domainStates = { allow: "✅ manual allow", block: "🚫 manual block", list: "📚 blocklist" };

async function domainsPage(page) {
  const data = await api("GET", `/api/domains?page=${page}`);
  const pager = h("div", { class: "pager" },
    h("button", { type: "button", disabled: data.page === 0, onclick: () => go(`#/domains/${data.page - 1}`) }, "← Prev"),
    h("span", { class: "muted" }, `${data.page + 1} / ${data.pageCount}`),
    h("button", { type: "button", disabled: data.page >= data.pageCount - 1, onclick: () => go(`#/domains/${data.page + 1}`) }, "Next →"),
  );

  return [
    h("h1", {}, "Observed domains"),
    h("p", { class: "muted" }, `${count(data.total)} domains. Choose Default, Allow or Block for each one.`),
    card(
      data.items.length ? data.items.map(item => domainRow(item)) : h("p", { class: "muted" }, "No domains observed yet."),
      data.pageCount > 1 ? pager : null,
    ),
  ];
}

function domainRow(item) {
  const lists = Array.isArray(item.blocklists) ? item.blocklists : item.blocklist ? [item.blocklist] : [];
  const sub = [
    `${item.decision === "block" ? "🚫 blocked" : "✅ allowed"} · ${domainStates[item.state] ?? "⚪ default"} · ${count(item.count)} queries`,
    item.matchedRule && item.matchedRule !== item.domain ? ` · rule ${item.matchedRule}` : "",
    lists.length ? ` · ${lists.map(list => shortListName(list.url)).slice(0, 2).join(", ")}${lists.length > 2 ? ` +${lists.length - 2}` : ""}` : "",
  ].join("");

  const el = row({ title: item.domain, sub });
  const current = item.state === "allow" || item.state === "block" ? item.state : "default";
  const choices = h("div", { class: "actions" },
    ["default", "allow", "block"].map(choice => action(
      { default: "Default", allow: "Allow", block: "Block" }[choice],
      async () => {
        const result = await api("POST", "/api/domains/rule", { action: choice, key: item.key });
        el.replaceWith(domainRow({ ...item, ...result, key: item.key, domain: item.domain, count: item.count }));
      },
      { class: choice === current ? "on" : null },
    )),
  );
  el.querySelector(".main").append(choices);
  return el;
}

// ---- Blocklists -----------------------------------------------------------

async function listsPage() {
  const data = await api("GET", "/api/lists");
  const items = data.items ?? [];

  const input = h("input", { type: "url", placeholder: "https://example.com/hosts.txt", required: true, "aria-label": "Blocklist URL" });
  const form = h("form", { class: "inline" }, input, h("button", { type: "submit", class: "primary" }, "Add"));
  form.addEventListener("submit", async event => {
    event.preventDefault();
    try {
      await api("POST", "/api/lists", { url: input.value });
      toast("Blocklist added");
      route();
    } catch (error) {
      toast(error.message, true);
    }
  });

  return [
    h("h1", {}, "Blocklists"),
    card(
      h("div", { class: "grid" },
        stat("Active", `${count(data.activeCount ?? items.filter(item => item.enabled).length)}/${items.length}`),
        stat("Unique domains", count(data.combinedDomainCount)),
        stat("Duplicates", count(data.duplicateEntries)),
        stat("Errors", count(data.unhealthyCount ?? items.filter(item => item.lastError).length)),
      ),
      h("div", { class: "actions" },
        action("🔄 Refresh all", async () => {
          toast("Refreshing blocklists…");
          const result = await api("POST", "/api/lists/refresh", {});
          toast(result.failed ? `Updated ${result.updated}, failed ${result.failed}` : "Blocklists refreshed", Boolean(result.failed));
          route();
        }),
      ),
    ),
    card(
      h("h2", {}, "Sources"),
      items.length ? items.map(listRow) : h("p", { class: "muted" }, "No external blocklists. Manual rules still apply."),
      h("p", { class: "sub muted" }, "Plain domains, hosts files and Adblock ||domain^ syntax are supported."),
      form,
    ),
  ];
}

function listRow(item) {
  const status = item.lastError ? h("span", { class: "chip warn" }, "error") : item.enabled ? h("span", { class: "chip ok" }, "active") : h("span", { class: "chip muted" }, "disabled");
  const el = row({
    title: shortListName(item.url),
    sub: [
      `${count(item.cachedDomainCount ?? item.domainCount)} domains`,
      item.enabled ? ` · ${count(item.uniqueDomainCount)} unique` : "",
      ` · updated ${date(item.updatedAt)}`,
      item.lastError ? ` · ⚠️ ${item.lastError}` : "",
    ].join(""),
    right: status,
  });
  el.querySelector(".main").append(
    h("div", { class: "sub" }, h("code", {}, item.url)),
    h("div", { class: "actions" },
      action(item.enabled ? "⏸ Disable" : "▶️ Enable", async () => {
        await api("POST", `/api/lists/${item.id}/enabled`, { enabled: !item.enabled });
        route();
      }),
      action("🔄 Refresh", async () => {
        await api("POST", `/api/lists/${item.id}/refresh`, {});
        toast("Blocklist refreshed");
        route();
      }),
      confirmAction("🗑 Remove", `Remove ${shortListName(item.url)}?`, async () => {
        await api("DELETE", `/api/lists/${item.id}`);
        toast("Blocklist removed");
        route();
      }, { class: "danger" }),
    ),
  );
  return el;
}

// ---- VPN ------------------------------------------------------------------

async function vpnPage() {
  const peers = await api("GET", "/api/vpn/peers");

  const input = h("input", { type: "text", placeholder: "e.g. phone-luca", pattern: "[A-Za-z0-9_\\-]{1,32}", required: true, "aria-label": "New user name" });
  const form = h("form", { class: "inline" }, input, h("button", { type: "submit", class: "primary" }, "Create"));
  form.addEventListener("submit", async event => {
    event.preventDefault();
    try {
      const peer = await api("POST", "/api/vpn/peers", { name: input.value.trim() });
      toast("VPN user created");
      go(`#/vpn/${encodeURIComponent(peer.name ?? input.value.trim())}`);
    } catch (error) {
      toast(error.message, true);
    }
  });

  return [
    h("h1", {}, "VPN users"),
    card(
      peers.length
        ? peers.map(peer => row({
            title: peer.name,
            sub: `${peer.ipv4} · last seen ${peer.handshake ? date(peer.handshake * 1000) : "never"}`,
            right: h("span", { class: `chip ${peer.enabled ? "ok" : "muted"}` }, peer.enabled ? "enabled" : "disabled"),
            onclick: () => go(`#/vpn/${encodeURIComponent(peer.name)}`),
          }))
        : h("p", { class: "muted" }, "No VPN users yet."),
    ),
    card(h("h2", {}, "New user"), h("p", { class: "sub muted" }, "Letters, numbers, _ or -."), form),
  ];
}

async function peerPage(name) {
  const peers = await api("GET", "/api/vpn/peers");
  const peer = peers.find(item => item.name === name);
  if (!peer) return [back("#/vpn", "VPN users"), card(h("p", {}, "This user no longer exists."))];

  const path = `/api/vpn/peers/${encodeURIComponent(name)}`;
  const qrBox = h("div");

  return [
    back("#/vpn", "VPN users"),
    h("h1", {}, `👤 ${peer.name}`),
    card(
      h("dl", {},
        h("dt", {}, "Status"), h("dd", {}, h("span", { class: `chip ${peer.enabled ? "ok" : "muted"}` }, peer.enabled ? "enabled" : "disabled")),
        h("dt", {}, "IPv4"), h("dd", {}, h("code", {}, peer.ipv4)),
        h("dt", {}, "Last handshake"), h("dd", {}, peer.handshake ? date(peer.handshake * 1000) : "never"),
        h("dt", {}, "Traffic"), h("dd", {}, `↓ ${bytes(peer.rx)} · ↑ ${bytes(peer.tx)}`),
        h("dt", {}, "LAN access"), h("dd", {}, h("a", { href: `#/vpn/${encodeURIComponent(name)}/lan` }, lanSummaryText(peer.lan), " →")),
      ),
      h("div", { class: "actions" },
        action(peer.enabled ? "⏸ Disable" : "▶️ Enable", async () => {
          await api("POST", `${path}/${peer.enabled ? "disable" : "enable"}`, {});
          route();
        }),
        action("📷 Show QR", async () => {
          qrBox.replaceChildren(
            h("img", { class: "qr", src: `${path}/qr?t=${Date.now()}`, alt: `WireGuard QR for ${name}` }),
            h("p", { class: "sub muted" }, "Scan it with the official WireGuard app. It contains private keys: do not share it."),
          );
        }),
        action("📄 Download config", async () => {
          const res = await fetch(url(`${path}/config`));
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          download(`${name}.conf`, await res.blob());
        }),
        confirmAction("🔑 Rotate keys", `Rotate keys for ${name}? The current configuration stops working.`, async () => {
          await api("POST", `${path}/rotate`, {});
          toast("Keys rotated: scan the new QR");
          qrBox.replaceChildren();
        }),
        confirmAction("🗑 Delete", `Permanently delete ${name}?`, async () => {
          await api("DELETE", path);
          toast("User deleted");
          go("#/vpn");
        }, { class: "danger" }),
      ),
      qrBox,
    ),
  ];
}

function lanSummaryText(acl) {
  if (!acl || acl.mode === "full") return "Full LAN";
  if (!acl.rules?.length) return "Internet only";
  const hosts = new Set(acl.rules.map(rule => rule.split("/")[0])).size;
  return `${hosts} device${hosts === 1 ? "" : "s"} · ${acl.rules.length} rule${acl.rules.length === 1 ? "" : "s"}`;
}

let lanPoll;

async function lanPage(name) {
  const path = `/api/vpn/peers/${encodeURIComponent(name)}/lan`;
  let data = await api("GET", path);
  if (!data.network && !data.scan.running) {
    await api("POST", "/api/lan/scan", {}).catch(() => {});
    data = await api("GET", path);
  }
  if (data.scan.running) {
    clearTimeout(lanPoll);
    lanPoll = setTimeout(() => { if (location.hash === `#/vpn/${encodeURIComponent(name)}/lan`) route(); }, 4000);
  }

  const container = h("div");
  const change = async body => {
    data = await api("POST", path, body);
    container.replaceChildren(...lanBody(name, data, change));
  };
  container.append(...lanBody(name, data, change));

  return [back(`#/vpn/${encodeURIComponent(name)}`, name), h("h1", {}, `🏠 LAN access · ${name}`), container];
}

function lanBody(name, data, change) {
  const network = data.scan.running
    ? h("p", {}, "🔍 Scanning the network…")
    : h("p", { class: "sub muted" },
        data.network ? `Network ${data.network.target ?? "?"} · ${data.network.hosts} devices · scanned ${date(data.network.scannedAt)}` : "Network not scanned yet.",
        data.scan.error ? h("span", { class: "warn" }, ` · last scan failed: ${data.scan.error}`) : null);

  const header = card(
    h("dl", {}, h("dt", {}, "Mode"), h("dd", {}, data.summary)),
    network,
    h("p", { class: "sub muted" }, "Internet always works. Choose which LAN devices and ports this user can reach."),
    h("div", { class: "actions" },
      action("🔓 Full LAN", () => change({ kind: "mode", mode: "full" }), { class: data.acl.mode === "full" ? "on" : null }),
      action("🌐 Internet only", () => change({ kind: "mode", mode: "none" }), { class: data.acl.mode === "custom" && !data.acl.rules.length ? "on" : null }),
      action("🔍 Rescan network", async () => {
        await api("POST", "/api/lan/scan", {});
        toast("Network scan started");
        route();
      }, { disabled: data.scan.running }),
    ),
  );

  if (data.acl.mode === "full") return [header, card(h("p", {}, "Every LAN device and port is reachable from this user."))];

  const input = h("input", { type: "text", placeholder: "192.168.1.50 · 192.168.1.50:8123 · 192.168.1.50 udp 1900", "aria-label": "Manual LAN rule" });
  const form = h("form", { class: "inline" }, input, h("button", { type: "submit" }, "Add rule"));
  form.addEventListener("submit", async event => {
    event.preventDefault();
    try {
      await change({ kind: "manual", text: input.value });
    } catch (error) {
      toast(error.message, true);
    }
  });

  return [
    header,
    card(
      h("h2", {}, "Devices"),
      data.devices.length
        ? data.devices.map(device => {
            const el = row({
              title: `${device.label} · ${device.ip}`,
              sub: [device.vendor && device.hostname ? device.vendor : null, device.discovered ? null : "not seen in last scan"].filter(Boolean).join(" · ") || null,
            });
            el.querySelector(".main").append(h("div", { class: "actions" },
              action("All ports", () => change({ kind: "all", ip: device.ip }), { class: device.all ? "on" : null }),
              device.all ? null : device.ports.map(port => action(port.label,
                () => change({ kind: "port", ip: device.ip, protocol: port.protocol, port: port.port }),
                { class: port.allowed ? "on" : null })),
            ));
            return el;
          })
        : h("p", { class: "muted" }, "No LAN devices discovered yet."),
    ),
    card(h("h2", {}, "Manual rule"), h("p", { class: "sub muted" }, "Only private LAN addresses are accepted."), form),
  ];
}

// ---- HTTPS integrations ---------------------------------------------------

async function integrationsPage() {
  const data = await api("GET", "/api/integrations");
  const runtime = data.runtime ?? {};
  const items = data.items ?? [];
  const output = h("div");

  return [
    h("h1", {}, "HTTPS integrations"),
    card(
      h("dl", {},
        h("dt", {}, "CA"), h("dd", {}, runtime.caReady ? "✅ Ready" : "❌ Not prepared"),
        h("dt", {}, "Active"), h("dd", {}, runtime.active ? `${runtime.integration} · ${String(runtime.mode ?? "").toUpperCase()}` : "None"),
        h("dt", {}, "Proxy"), h("dd", {}, runtime.proxyState ?? "unknown"),
        h("dt", {}, "HTTPS"), h("dd", {}, runtime.interception ?? "unknown"),
        h("dt", {}, "QUIC"), h("dd", {}, runtime.quic ?? "unknown"),
      ),
      h("p", { class: "sub muted" }, "The CA is only needed for explicit HTTPS inspection tests. DNS blocking does not require it."),
    ),
    items.length
      ? items.map(item => integrationCard(item, runtime, output))
      : card(h("p", { class: "muted" }, "No integrations registered.")),
    output,
  ];
}

function integrationCard(item, runtime, output) {
  const activeHere = Boolean(runtime.active && runtime.integration === item.id);
  const actions = (item.actions ?? []).filter(a => !(a.visibleWhen === "active" && !activeHere) && !(a.visibleWhen === "inactive" && activeHere));
  const observation = item.observation ?? {};

  return card(
    h("h2", {}, `${activeHere ? "🟢" : "⚪"} ${item.name}`),
    item.description ? h("p", {}, item.description) : null,
    h("p", { class: "sub muted" }, `Strategy ${item.status ?? "experimental"} · log ${bytes(observation.bytes)} · updated ${date(observation.modifiedAt)}`),
    h("div", { class: "actions" }, actions.map(a => action(a.label, async () => {
      toast("Operation in progress…");
      const result = await api("POST", `/api/integrations/${item.id}/actions/${a.id}`, {});
      const shown = [];
      if (result.certificate) {
        const raw = Uint8Array.from(atob(result.certificate.base64), c => c.charCodeAt(0));
        download(result.certificate.filename, new Blob([raw], { type: result.certificate.contentType }));
        shown.push(card(h("h2", {}, "🛡 TunnelBlock HTTPS CA"),
          h("p", {}, "SHA-256 ", h("code", {}, result.certificate.fingerprint256)),
          h("p", { class: "warn" }, "Install and trust this certificate only on a dedicated test device.")));
      }
      if (result.summary) shown.push(summaryCard(item.name, result.summary));
      output.replaceChildren(...shown);
      if (!shown.length) route();
    }))),
  );
}

function summaryCard(name, s) {
  const verdict = Number(s.httpRequests) > 0
    ? "✅ HTTPS was readable for at least part of the traffic."
    : s.likelyCertificatePinning
      ? "⚠️ Result is compatible with certificate pinning or CA rejection."
      : "ℹ️ Not enough data to evaluate TLS inspection.";
  return card(
    h("h2", {}, `📊 ${name}`),
    h("div", { class: "grid" },
      stat("ClientHello", count(s.tlsClientHello)),
      stat("TLS established", count(s.tlsEstablished)),
      stat("TLS failed", count(s.tlsFailed)),
      stat("HTTP requests", count(s.httpRequests)),
      stat("HTTP responses", count(s.httpResponses)),
      stat("HTTPS hosts", count(s.uniqueHosts)),
    ),
    h("p", {}, verdict),
  );
}

// ---- Router ---------------------------------------------------------------

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

let renderId = 0;

async function route() {
  const id = ++renderId;
  const parts = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  const tab = parts[0] || "overview";

  for (const link of document.querySelectorAll("#nav a")) {
    link.classList.toggle("active", link.dataset.tab === tab);
  }

  let content;
  try {
    if (tab === "domains") content = await domainsPage(Number(parts[1] ?? 0) || 0);
    else if (tab === "lists") content = await listsPage();
    else if (tab === "vpn" && parts[1] && parts[2] === "lan") content = await lanPage(parts[1]);
    else if (tab === "vpn" && parts[1]) content = await peerPage(parts[1]);
    else if (tab === "vpn") content = await vpnPage();
    else if (tab === "integrations") content = await integrationsPage();
    else content = await overviewPage();
  } catch (error) {
    content = card(h("p", { class: "bad" }, `Unable to load: ${error.message}`), h("div", { class: "actions" }, action("Retry", route)));
  }

  // A slower, older render must not overwrite the page the user moved to.
  if (id === renderId) view.replaceChildren(...[content].flat());
}

window.addEventListener("hashchange", route);
route();
