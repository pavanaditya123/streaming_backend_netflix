/* global document, window, sessionStorage, FormData, location, crypto */
const main = document.querySelector("#main");
const modal = document.querySelector("#modal");
const content = document.querySelector("#modal-content");
let token = sessionStorage.getItem("frame-token");
let pageVersion = 0;
let noticeTimer;
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const post = (body = {}) => ({ method: "POST", body });
async function api(path, options = {}) {
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(12000),
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && token) {
      token = null;
      sessionStorage.removeItem("frame-token");
      updateAuth();
    }
    throw new Error(
      data.error?.message || `Request failed (${response.status})`,
    );
  }
  return data;
}
function notify(message) {
  const el = document.querySelector("#notice");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    el.hidden = true;
  }, 6000);
}
function updateAuth() {
  document.querySelector("#auth-button").textContent = token
    ? "Sign out ↗"
    : "Sign in ↗";
}
function openModal(html) {
  content.innerHTML = html;
  if (!modal.open) modal.showModal();
}
document.querySelector("#close-modal").onclick = () => modal.close();
function auth(register = false) {
  openModal(
    `<p class="eyebrow">Your next great story</p><h2 id="modal-title">${register ? "Join Frame" : "Welcome back"}</h2><form id="auth-form">${register ? '<label>Your name<input name="displayName" autocomplete="name" maxlength="60" required></label>' : ""}<label>Email<input name="email" type="email" autocomplete="email" required></label><label>Password<input name="password" type="password" autocomplete="${register ? "new-password" : "current-password"}" minlength="${register ? 8 : 1}" required></label>${register ? "<small>Use at least 8 characters, including a letter and a number. Demo accounts reset when the memory server restarts.</small>" : ""}<p class="error" role="alert" id="auth-error"></p><button class="full">${register ? "Create account" : "Sign in"}</button></form><p><button class="quiet full" id="switch-auth">${register ? "Already a member? Sign in" : "New here? Create an account"}</button></p>`,
  );
  document.querySelector("#switch-auth").onclick = () => auth(!register);
  document.querySelector("#auth-form").onsubmit = async (event) => {
    event.preventDefault();
    const button = event.target.querySelector("button");
    const errorEl = document.querySelector("#auth-error");
    button.disabled = true;
    try {
      const result = await api(
        `/auth/${register ? "register" : "login"}`,
        post(Object.fromEntries(new FormData(event.target))),
      );
      token = result.token;
      sessionStorage.setItem("frame-token", token);
      updateAuth();
      modal.close();
      await render();
    } catch (error) {
      errorEl.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };
}
document.querySelector("#auth-button").onclick = () => {
  if (!token) return auth();
  token = null;
  sessionStorage.removeItem("frame-token");
  updateAuth();
  render();
};
function cards(items) {
  return items.length
    ? `<div class="grid">${items.map((title) => `<button class="card" data-title="${esc(title.id)}" data-resume="${Number(title.resumeAtSeconds) || 0}" aria-label="View ${esc(title.title)}"><div class="poster"><small>FRAME COLLECTION · ${esc(title.type)}</small><strong>${esc(title.title)}</strong><small>${esc(title.genres?.[0] || "Cinema")} / ${esc(title.year)}</small></div><h3>${esc(title.title)}</h3><div class="meta">${esc(title.year)} · ${esc(title.durationMinutes)} min · ★ ${esc(title.rating)}${title.resumeAtSeconds ? ` · Resume at ${Math.floor(title.resumeAtSeconds / 60)} min` : ""}</div></button>`).join("")}</div>`
    : '<p class="empty">No titles found. Try another search.</p>';
}
function bindCards() {
  main.querySelectorAll("[data-title]").forEach((el) => {
    el.onclick = () =>
      detail(el.dataset.title, Number(el.dataset.resume) || 0).catch((e) =>
        notify(e.message),
      );
  });
}
async function detail(id, resumeAtSeconds = 0) {
  const { title } = await api(`/titles/${encodeURIComponent(id)}`);
  openModal(
    `<p class="eyebrow">${esc(title.type)} · Frame collection</p><h2 id="modal-title">${esc(title.title)}</h2><p class="detail-meta">${esc(title.year)} · ${esc(title.maturity)} · ★ ${esc(title.rating)} · ${esc(title.durationMinutes)} min</p><p>${esc(title.description)}</p><p class="muted">${esc(title.genres.join(" / "))}<br>Directed by ${esc(title.director)}<br>${esc(title.cast.join(", "))}</p><p>Included with ${esc(title.plans.join(", "))}.</p><button id="start-session">${resumeAtSeconds ? "Resume playback demo" : "Start playback demo"}</button><p class="muted">This demo tracks a real session and watch progress. Movie video files are not included.</p>`,
  );
  document.querySelector("#start-session").onclick = async (event) => {
    event.target.disabled = true;
    try {
      const result = await api(
        "/playback/sessions",
        post({ titleId: id, deviceId: "frame-web" }),
      );
      if (resumeAtSeconds) {
        try {
          const progress = await api(
            `/playback/sessions/${encodeURIComponent(result.session.id)}/progress`,
            post({ positionSeconds: resumeAtSeconds }),
          );
          result.session = progress.session;
        } catch (error) {
          notify(`Session started, but resume failed: ${error.message}`);
        }
      }
      player(result.session, title);
    } catch (error) {
      notify(error.message);
      event.target.disabled = false;
    }
  };
}
function player(session, title) {
  openModal(
    `<p class="eyebrow">Playback demo · ${esc(session.quality)}</p><h2 id="modal-title">${esc(title.title)}</h2><p>Move the slider to simulate your viewing position, then save or end the session. No video is streamed.</p><label>Position: <output id="position">${session.positionSeconds} seconds</output><input class="progress" id="progress" type="range" min="0" max="${title.durationMinutes * 60}" value="${session.positionSeconds}"></label><div class="actions"><button id="save-progress">Save progress</button><button class="quiet" id="stop-session">End session</button></div><p class="muted">You can manage open sessions from My account.</p>`,
  );
  const range = document.querySelector("#progress");
  range.oninput = () => {
    document.querySelector("#position").textContent = `${range.value} seconds`;
  };
  for (const [selector, action] of [
    ["#save-progress", "progress"],
    ["#stop-session", "stop"],
  ]) {
    document.querySelector(selector).onclick = async (event) => {
      event.target.disabled = true;
      try {
        await api(
          `/playback/sessions/${encodeURIComponent(session.id)}/${action}`,
          post({ positionSeconds: Number(range.value) }),
        );
        notify(
          action === "stop"
            ? "Session ended. Watch history saved."
            : "Progress saved.",
        );
        if (action === "stop") {
          modal.close();
          await render();
        }
      } catch (error) {
        notify(error.message);
      } finally {
        event.target.disabled = false;
      }
    };
  }
}
async function render() {
  const version = ++pageVersion;
  const route = location.hash.slice(1) || "home";
  document.querySelectorAll("nav a").forEach((a) => {
    if (a.hash === `#${route}`) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  main.innerHTML =
    '<p class="empty" role="status">Loading your next story…</p>';
  try {
    if (route === "plans") return await plans(version);
    if (!token) {
      main.innerHTML = `<section class="hero"><p class="eyebrow">Good stories stay with you</p><h1>Find your next<br>great escape.</h1><p>Big-screen adventures. Quiet little masterpieces. Stories from around the world, all in one place.</p><div class="actions"><button id="join">Start exploring ↗</button><a class="quiet panel" href="#plans">Explore plans</a></div></section><div class="section-head"><h2>A world of stories. Your kind of cinema.</h2></div><div class="plans"><div class="panel"><p class="eyebrow">01 / Discover</p><h2>Follow your mood</h2><p class="muted">Search for “korean thrillers” or “something funny” and discover a new favorite.</p></div><div class="panel"><p class="eyebrow">02 / Make it yours</p><h2>Pick your plan</h2><p class="muted">Three plans, from casual viewing to the full collection.</p></div><div class="panel"><p class="eyebrow">03 / Pick up again</p><h2>Keep your place</h2><p class="muted">Explore playback tracking and a personalized continue-watching collection.</p></div></div>`;
      document.querySelector("#join").onclick = () => auth(true);
      return;
    }
    if (route === "account") return await account(version);
    const isHome = route === "home";
    const data = await api(
      isHome
        ? "/home"
        : `/titles?limit=24&type=${route === "series" ? "series" : "movie"}`,
    );
    if (version !== pageVersion) return;
    const rails = isHome
      ? data.rails
      : [
          {
            title:
              route === "series"
                ? "Series worth staying in for"
                : "A night at the movies",
            items: data.items,
          },
        ];
    const featured = rails.flatMap((r) => r.items)[0];
    main.innerHTML = `${isHome ? `<section class="hero"><p class="eyebrow">The evening edit / Selected for you</p><h1>${esc(featured?.title || "Make time for a great story.")}</h1><p>${esc(featured?.description || "Explore the collection to find your next favorite.")}</p>${featured ? `<button data-title="${esc(featured.id)}">Explore title ↗</button>` : ""}</section>` : ""}<form class="search" id="search"><input name="query" aria-label="Search titles or describe your mood" placeholder="Try “mind-bending movies” or “korean thrillers”…" maxlength="120" required><button>Find a story ↗</button></form><div id="results">${rails.map((rail) => `<section><div class="section-head"><h2>${esc(rail.title)}</h2><span class="muted">${rail.items.length} titles</span></div>${cards(rail.items)}</section>`).join("") || '<p class="empty">The collection is temporarily unavailable. Try refreshing.</p>'}</div>`;
    bindCards();
    if (!isHome && data.items.length < data.total) {
      let offset = data.items.length;
      const more = document.createElement("button");
      more.textContent = "Load more titles";
      more.className = "load-more quiet";
      document.querySelector("#results").append(more);
      more.onclick = async () => {
        more.disabled = true;
        try {
          const next = await api(
            `/titles?limit=24&offset=${offset}&type=${route === "series" ? "series" : "movie"}`,
          );
          if (version !== pageVersion || !more.isConnected) return;
          more.insertAdjacentHTML("beforebegin", cards(next.items));
          offset += next.items.length;
          more.hidden = offset >= next.total;
          bindCards();
        } catch (error) {
          notify(error.message);
        } finally {
          more.disabled = false;
        }
      };
    }
    document.querySelector("#search").onsubmit = async (event) => {
      event.preventDefault();
      const button = event.target.querySelector("button");
      button.disabled = true;
      try {
        const result = await api(
          "/recommendations/search",
          post({ query: new FormData(event.target).get("query") }),
        );
        if (version !== pageVersion) return;
        document.querySelector("#results").innerHTML =
          `<div class="section-head"><h2>Search results</h2></div><p class="muted">${esc(result.explanation)}</p>${cards(result.items)}`;
        bindCards();
      } catch (error) {
        notify(error.message);
      } finally {
        button.disabled = false;
      }
    };
  } catch (error) {
    if (version !== pageVersion) return;
    main.innerHTML = `<div class="empty"><h2>We couldn’t load this page</h2><p>${esc(error.message)}</p><button id="retry">Try again</button></div>`;
    document.querySelector("#retry").onclick = render;
  }
}
async function plans(version) {
  const [{ plans: available }, entitlement] = await Promise.all([
    api("/plans"),
    token ? api("/subscriptions/entitlement") : null,
  ]);
  if (version !== pageVersion) return;
  main.innerHTML = `<p class="eyebrow">Make room for more stories</p><h1>A plan for your kind of evening.</h1><p class="muted">Monthly plans. Demo payments only — no real card details or charges.</p><div class="plans">${available.map((p) => `<section class="panel plan"><p class="eyebrow">${esc(p.name)}</p><p class="price">₹${p.priceMinor / 100}<small> / month</small></p><ul><li>Up to ${esc(p.maxQuality)} quality</li><li>${p.maxStreams} simultaneous stream${p.maxStreams > 1 ? "s" : ""}</li><li>${p.downloads ? "Downloads included in plan entitlement" : "Stream on your favorite device"}</li></ul><button class="full" data-plan="${esc(p.id)}" ${entitlement?.entitled ? "disabled" : ""}>${entitlement?.planId === p.id ? "Your current plan" : entitlement?.entitled ? "Cancel current plan to switch" : `Choose ${esc(p.name)}`}</button></section>`).join("")}</div><p class="muted">Quality and download benefits are modeled by the backend; video delivery and downloads are not implemented.</p>`;
  main.querySelectorAll("[data-plan]").forEach((button) => {
    button.onclick = async () => {
      if (!token) return auth(true);
      const buttons = main.querySelectorAll("[data-plan]");
      buttons.forEach((b) => {
        b.disabled = true;
      });
      try {
        const started = await api("/subscriptions", {
          ...post({ planId: button.dataset.plan, paymentMethod: {} }),
          headers: { "Idempotency-Key": crypto.randomUUID() },
        });
        for (let attempt = 0; attempt < 20; attempt++) {
          const result = await api(
            `/subscriptions/${encodeURIComponent(started.subscriptionId)}`,
          );
          if (result.subscription.status === "active") {
            notify("Your plan is active. Enjoy exploring.");
            await render();
            return;
          }
          if (result.subscription.status === "failed")
            throw new Error(
              result.subscription.failureReason ||
                "Subscription failed. Please try again.",
            );
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        notify(
          "Payment is still processing. Check My account for the latest status.",
        );
        location.hash = "account";
      } catch (error) {
        notify(error.message);
      } finally {
        buttons.forEach((b) => {
          b.disabled = false;
        });
      }
    };
  });
}
async function account(version) {
  const [profile, subscriptions, payments, notifications, sessions] =
    await Promise.all([
      api("/me"),
      api("/subscriptions"),
      api("/billing/payments"),
      api("/notifications"),
      api("/playback/sessions/active"),
    ]);
  if (version !== pageVersion) return;
  main.innerHTML = `<p class="eyebrow">Your corner of Frame</p><h1>Hello, ${esc(profile.user.displayName)}.</h1><div class="account-grid"><section class="panel"><h2>Profile</h2><form id="profile"><label>Display name<input name="displayName" value="${esc(profile.user.displayName)}" maxlength="60" required></label><p class="muted">${esc(profile.user.email)}</p><button>Save profile</button></form></section><section class="panel"><h2>Subscriptions</h2>${subscriptions.items.map((s) => `<div class="row"><div><strong>${esc(s.planId)}</strong><p class="muted">${esc(s.status)} · ${esc(s.price)}</p></div>${s.status === "active" ? `<button class="quiet" data-cancel="${esc(s.id)}">Cancel plan</button>` : ""}</div>`).join("") || '<p class="muted">No subscription yet.</p>'}<p><a href="#plans">Explore plans ↗</a></p></section><section class="panel"><h2>Payment history</h2>${payments.items.map((p) => `<div class="row"><span>${esc(p.amount)}</span><span>${esc(p.status)}</span></div>`).join("") || '<p class="muted">No payments yet.</p>'}</section><section class="panel"><h2>Notifications</h2><button class="quiet" id="read-all">Mark all as read</button>${notifications.items.map((n) => `<div class="row"><div><strong>${n.read ? "" : "● "}${esc(n.subject)}</strong><p class="muted">${esc(n.body)}</p></div></div>`).join("") || '<p class="muted">You’re all caught up.</p>'}</section><section class="panel"><h2>Active playback sessions</h2>${sessions.items.map((s) => `<div class="row"><span>${esc(s.titleId)} · ${esc(s.quality)}</span><button class="quiet" data-stop="${esc(s.id)}">End session</button></div>`).join("") || '<p class="muted">No active sessions.</p>'}</section></div>`;
  document.querySelector("#profile").onsubmit = async (event) => {
    event.preventDefault();
    try {
      await api("/me", {
        method: "PUT",
        body: Object.fromEntries(new FormData(event.target)),
      });
      notify("Profile saved.");
      await render();
    } catch (error) {
      notify(error.message);
    }
  };
  document.querySelector("#read-all").onclick = () =>
    mutate("/notifications/read-all");
  main.querySelectorAll("[data-stop]").forEach((b) => {
    b.onclick = () =>
      mutate(`/playback/sessions/${encodeURIComponent(b.dataset.stop)}/stop`);
  });
  main.querySelectorAll("[data-cancel]").forEach((b) => {
    b.onclick = () => {
      openModal(
        '<h2 id="modal-title">Cancel your plan?</h2><p>You won’t be able to start new playback sessions. You can subscribe again anytime.</p><button id="confirm-cancel">Confirm cancellation</button>',
      );
      document.querySelector("#confirm-cancel").onclick = async () => {
        await mutate(
          `/subscriptions/${encodeURIComponent(b.dataset.cancel)}/cancel`,
        );
        modal.close();
      };
    };
  });
}
async function mutate(path) {
  try {
    await api(path, post());
    await render();
  } catch (error) {
    notify(error.message);
  }
}
window.addEventListener("hashchange", () => {
  modal.close();
  render();
});
updateAuth();
render();
