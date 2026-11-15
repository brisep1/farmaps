(() => {
  const cfg = window.APP_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const pesos = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
  const COLORES = { "Cruz Verde": "#1a8f4c", "Ahumada": "#d6322c", "Salcobrand": "#1463b8", "Dr. Simi": "#7c3aed" };
  const GRIS = "#6b7280";
  const SANTIAGO = [-33.4489, -70.6693];

  const estado = { pos: null, posEsReal: false, cadena: null, capa: null, yo: null };

  document.title = cfg.NOMBRE || "Farmaps";
  // marca en dos tonos, como el "Farma|gül" original
  const nombre = cfg.NOMBRE || "Farmaps";
  const corte = nombre.startsWith("Farma") && nombre.length > 5 ? 5 : nombre.length;
  $("marca").replaceChildren(nombre.slice(0, corte), Object.assign(document.createElement("span"), { textContent: nombre.slice(corte) }));

  // ---------- utilidades ----------

  function el(tag, attrs = {}, ...hijos) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k === "style") n.style.cssText = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const h of hijos) if (h != null) n.append(h);  // texto siempre como texto, nunca HTML
    return n;
  }

  function aviso(texto) {
    $("aviso").hidden = !texto;
    $("aviso").textContent = texto || "";
  }

  async function api(ruta, cuerpo) {
    const r = await fetch(cfg.SUPABASE_URL + "/rest/v1/" + ruta, {
      method: cuerpo ? "POST" : "GET",
      headers: {
        apikey: cfg.SUPABASE_KEY,
        Authorization: "Bearer " + cfg.SUPABASE_KEY,
        "Content-Type": "application/json",
      },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    if (!r.ok) throw new Error("Error " + r.status + " al consultar los datos");
    return r.json();
  }

  const distancia = (m) => (m < 1000 ? Math.round(m / 10) * 10 + " m" : (m / 1000).toFixed(1).replace(".", ",") + " km");
  const hora = (iso) => new Date(iso).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", hour12: false });
  const comoLlegar = (l) => "https://www.google.com/maps/dir/?api=1&destination=" + l.latitud + "," + l.longitud;

  // ---------- mapa ----------

  const mapa = L.map("mapa", { zoomControl: false }).setView(SANTIAGO, 12);
  L.control.zoom({ position: "bottomright" }).addTo(mapa);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(mapa);
  estado.capa = L.layerGroup().addTo(mapa);

  function fijarPosicion(lat, lng, real) {
    estado.pos = [lat, lng];
    estado.posEsReal = real;
    if (estado.yo) estado.yo.remove();
    estado.yo = L.circleMarker(estado.pos, {
      radius: 8, color: "#fff", weight: 3, fillColor: "#2563eb", fillOpacity: 1,
    }).addTo(mapa).bindTooltip(real ? "Tu ubicación" : "Punto de partida");
    cargarLocales();
  }

  function ubicarme() {
    if (!navigator.geolocation) return aviso("Tu navegador no entrega ubicación. Toca el mapa para fijar un punto.");
    navigator.geolocation.getCurrentPosition(
      (p) => { aviso(""); fijarPosicion(p.coords.latitude, p.coords.longitude, true); },
      () => {
        aviso("No pudimos obtener tu ubicación. Mostramos el centro de Santiago; toca el mapa para cambiar el punto.");
        if (!estado.pos) fijarPosicion(SANTIAGO[0], SANTIAGO[1], false);
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  mapa.on("click", (e) => fijarPosicion(e.latlng.lat, e.latlng.lng, false));
  $("ubicarme").addEventListener("click", ubicarme);

  // ---------- locales cercanos ----------

  async function cargarLocales() {
    if (!estado.pos) return;
    const soloTurno = $("soloTurno").checked;
    let locales;
    try {
      locales = await api("rpc/locales_cercanos", {
        lat: estado.pos[0], lng: estado.pos[1],
        cadenas: estado.cadena ? [estado.cadena] : null,
        solo_turno: soloTurno, limite: 25,
      });
    } catch (e) { return aviso(e.message); }

    estado.capa.clearLayers();
    const caja = $("locales");
    caja.replaceChildren();
    const titulo = (soloTurno ? "De turno ahora" : "Farmacias cercanas") + (estado.cadena ? " · " + estado.cadena : "");
    caja.append(el("h2", {}, titulo));

    if (!locales.length) {
      caja.append(el("p", { class: "vacio" },
        soloTurno ? "No encontramos farmacias de turno" + (estado.cadena ? " de esta cadena" : "") + " cerca. Prueba quitando el filtro."
                  : "No encontramos locales cerca de este punto."));
      return;
    }

    const limites = [estado.pos];
    locales.forEach((l, i) => {
      const color = COLORES[l.cadena] || GRIS;
      const marcador = L.circleMarker([l.latitud, l.longitud], {
        radius: l.de_turno ? 10 : 7, color: l.de_turno ? "#b45309" : "#fff", weight: l.de_turno ? 4 : 2,
        fillColor: color, fillOpacity: 1,
      }).addTo(estado.capa);
      marcador.bindPopup(el("div", {},
        el("strong", {}, l.nombre),
        el("span", {}, l.direccion + ", " + l.comuna), el("br"),
        l.de_turno ? el("span", {}, "De turno hasta las " + hora(l.turno_fin)) : null,
        l.de_turno ? el("br") : null,
        el("a", { href: comoLlegar(l), target: "_blank", rel: "noopener" }, "Cómo llegar")));
      if (i < 5) limites.push([l.latitud, l.longitud]);

      if (i < 8) {
        caja.append(el("div", { class: "local" },
          el("div", { class: "titulo" },
            el("span", { class: "punto", style: "background:" + color }),
            el("span", {}, l.nombre),
            l.de_turno ? el("span", { class: "etiqueta turno" }, "Turno hasta " + hora(l.turno_fin)) : null),
          el("div", { class: "dir" }, l.direccion + ", " + l.comuna + " · " + distancia(l.distancia_m)),
          el("div", { class: "acciones" },
            el("a", { href: comoLlegar(l), target: "_blank", rel: "noopener" }, "Cómo llegar"),
            l.telefono ? el("a", { href: "tel:" + l.telefono.replace(/[^+\d]/g, "") }, "Llamar") : null,
            el("a", { href: "#", onclick: (ev) => { ev.preventDefault(); mapa.setView([l.latitud, l.longitud], 16); marcador.openPopup(); } }, "Ver en el mapa"))));
      }
    });
    mapa.fitBounds(limites, { padding: [50, 50], maxZoom: 16 });
  }

  // ---------- busqueda y comparacion ----------

  async function buscar(q) {
    const caja = $("resultados");
    caja.replaceChildren(el("p", { class: "vacio" }, "Buscando…"));
    let filas;
    try {
      filas = await api("comparador?select=*&principio_activo=ilike.*" + encodeURIComponent(q.replace(/[*%,()]/g, " ").trim()) + "*&order=precio.asc&limit=300");
    } catch (e) { caja.replaceChildren(); return aviso(e.message); }

    caja.replaceChildren(el("h2", {}, "Precios"));
    if (!filas.length) {
      caja.append(el("p", { class: "vacio" }, "Aún no tenemos precios para “" + q + "”. Por ahora hay pocos medicamentos cargados."));
      return;
    }

    const grupos = new Map();
    for (const f of filas) {
      if (!grupos.has(f.medicamento_id)) grupos.set(f.medicamento_id, []);
      grupos.get(f.medicamento_id).push(f);
    }
    const orden = [...grupos.values()].sort((a, b) =>
      new Set(b.map((x) => x.cadena)).size - new Set(a.map((x) => x.cadena)).size || a[0].mg - b[0].mg || a[0].unidades - b[0].unidades);

    for (const g of orden) {
      const m = g[0];
      // el ahorro se mide contra la siguiente opcion mas barata de OTRA cadena,
      // no contra la mas cara (que suele ser una marca y exagera la diferencia)
      const siguiente = g.find((f) => f.cadena !== m.cadena && f.precio > m.precio);
      const tarjeta = el("div", { class: "grupo" },
        el("h3", {}, m.principio_activo + " " + Number(m.mg) + " mg · " + m.unidades + " comprimidos"));
      g.forEach((f, i) => {
        const ahorro = i === 0 && siguiente
          ? "Ahorras " + pesos.format(siguiente.precio - f.precio) + " frente a " + siguiente.cadena : null;
        tarjeta.append(el("button", {
          class: "cadena" + (i === 0 ? " barata" : ""), type: "button", "data-cadena": f.cadena,
          title: "Ver locales de " + f.cadena + " en el mapa",
          onclick: () => elegirCadena(f.cadena),
        },
          el("span", { class: "nombre" },
            el("span", { class: "punto", style: "background:" + (COLORES[f.cadena] || GRIS) }),
            f.cadena, i === 0 && g.length > 1 ? el("span", { class: "etiqueta" }, "Más barato") : null),
          el("span", { class: "precio" }, pesos.format(f.precio)),
          el("span", { class: "detalle" }, f.producto + (ahorro ? " · " + ahorro : "")),
          el("span", { class: "unidad" }, pesos.format(f.precio_unidad) + " c/u")));
      });
      caja.append(tarjeta);
    }
    marcarCadena();
  }

  function marcarCadena() {
    document.querySelectorAll(".cadena").forEach((b) => b.classList.toggle("activa", b.dataset.cadena === estado.cadena));
  }

  function elegirCadena(cadena) {
    estado.cadena = estado.cadena === cadena ? null : cadena;  // segundo clic quita el filtro
    marcarCadena();
    cargarLocales();
  }

  $("buscador").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = $("q").value.trim();
    if (q) { estado.cadena = null; buscar(q); cargarLocales(); }
  });
  $("soloTurno").addEventListener("change", cargarLocales);

  // ---------- inicio ----------

  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_KEY) {
    aviso("Falta configurar la clave pública de Supabase en config.js. Sin ella no se pueden cargar precios ni farmacias.");
    return;
  }

  // de noche lo urgente es que este abierta: se activa el filtro de turno
  const h = new Date().getHours();
  if (h >= 21 || h < 8) $("soloTurno").checked = true;

  api("medicamentos?select=principio_activo").then((ms) => {
    [...new Set(ms.map((m) => m.principio_activo))].sort().forEach((p) => $("sugerencias").append(el("option", { value: p })));
  }).catch(() => {});

  ubicarme();
})();
