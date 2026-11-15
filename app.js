(() => {
  const cfg = window.APP_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const pesos = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
  const COLORES = { "Cruz Verde": "#1a8f4c", "Ahumada": "#d6322c", "Salcobrand": "#1463b8", "Dr. Simi": "#7c3aed",
    "EcoFarmacias": "#0891b2", "Farmex": "#ea580c", "El Químico": "#be185d" };
  const GRIS = "#6b7280";
  const SANTIAGO = [-33.4489, -70.6693];

  const estado = { pos: null, posEsReal: false, cadena: null, capa: null, yo: null,
                   cercanas: new Map(), datos: null };
  const RADIO_CERCA = 5000;  // metros: hasta aqui un local cuenta como "cerca"

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
    return r.status === 204 ? null : r.json();
  }

  const distancia = (m) => (m < 1000 ? Math.round(m / 10) * 10 + " m" : (m / 1000).toFixed(1).replace(".", ",") + " km");
  const hora = (iso) => new Date(iso).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", hour12: false });
  const haceDias = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  // abre la ruta desde donde esta la persona; a pie si queda a menos de 1,5 km
  const comoLlegar = (l) => "https://www.google.com/maps/dir/?api=1&destination=" + l.latitud + "," + l.longitud
    + (estado.posEsReal ? "&origin=" + estado.pos[0] + "," + estado.pos[1] : "")
    + (l.distancia_m != null && l.distancia_m < 1500 ? "&travelmode=walking" : "");

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
    cargarCercanas();
  }

  // el local mas cercano de cada cadena, para mostrar distancia y ruta en cada precio
  async function cargarCercanas() {
    try {
      const filas = await api("rpc/cadenas_cercanas", { lat: estado.pos[0], lng: estado.pos[1] });
      estado.cercanas = new Map(filas.map((f) => [f.cadena, f]));
    } catch (e) { estado.cercanas = new Map(); }
    pintarResultados();
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
        : estado.cadena ? "No tenemos locales de " + estado.cadena + " en el mapa. Puede que venda solo por internet: revisa su sitio antes de ir."
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
    let filas, otros;
    const termino = encodeURIComponent(q.replace(/[*%,()]/g, " ").trim());
    try {
      [filas, otros] = await Promise.all([
        api("comparador?select=*&principio_activo=ilike.*" + termino + "*&fecha=gte." + haceDias(4) + "&order=precio.asc&limit=500"),
        api("catalogo?select=*&producto=ilike.*" + termino + "*&medicamento_id=is.null&fecha=gte." + haceDias(4) + "&order=precio.asc&limit=200"),
      ]);
    } catch (e) { caja.replaceChildren(); return aviso(e.message); }

    estado.datos = { q, filas, otros };
    pintarResultados();
  }

  function pintarResultados() {
    if (!estado.datos) return;
    const { q } = estado.datos;
    const caja = $("resultados");
    const soloCerca = $("soloLocal").checked;
    const local = (f) => estado.cercanas.get(f.cadena);
    const cerca = (f) => { const l = local(f); return l && l.distancia_m <= RADIO_CERCA; };
    const filtrar = (lista) => (soloCerca ? lista.filter(cerca) : lista);
    const filas = filtrar(estado.datos.filas);
    const otros = filtrar(estado.datos.otros);
    const ocultas = estado.datos.filas.length + estado.datos.otros.length - filas.length - otros.length;

    caja.replaceChildren(el("h2", {}, "Precios"));
    if (!estado.datos.filas.length && !estado.datos.otros.length) {
      caja.append(el("p", { class: "vacio" }, "Aún no tenemos precios para “" + q + "”. Prueba con el principio activo (por ejemplo, losartán en vez de la marca)."));
      return;
    }
    const ultima = estado.datos.filas.concat(estado.datos.otros).reduce((a, f) => (f.fecha > a ? f.fecha : a), "");
    caja.append(el("p", { class: "fecha" }, "Precios web revisados el " + ultima.split("-").reverse().join("-") + "."));
    if (ocultas) {
      caja.append(el("p", { class: "ocultas" },
        "Ocultamos " + ocultas + (ocultas === 1 ? " opción" : " opciones") + " sin local a menos de 5 km. ",
        el("a", { href: "#", onclick: (e) => { e.preventDefault(); $("soloLocal").checked = false; pintarResultados(); } }, "Mostrar todas")));
    }
    if (!filas.length && !otros.length) {
      caja.append(el("p", { class: "vacio" }, "Ninguna farmacia con local cerca lo tiene. Mira todas las opciones para comprar por internet."));
      return;
    }

    const grupos = new Map();
    for (const f of filas) {
      if (!grupos.has(f.medicamento_id)) grupos.set(f.medicamento_id, []);
      grupos.get(f.medicamento_id).push(f);
    }
    const orden = [...grupos.values()].sort((a, b) =>
      new Set(b.map((x) => x.cadena)).size - new Set(a.map((x) => x.cadena)).size || a[0].mg - b[0].mg || a[0].unidades - b[0].unidades);

    // cada opcion: el precio (al tocarlo, sus locales en el mapa) y debajo el local mas cercano con su ruta
    const fila = (f, destacada, ahorro) => {
      const l = local(f);
      return el("div", { class: "opcion" + (destacada ? " barata" : "") },
        el("button", {
          class: "cadena", type: "button", "data-cadena": f.cadena,
          title: "Ver locales de " + f.cadena + " en el mapa",
          onclick: () => elegirCadena(f.cadena),
        },
          el("span", { class: "nombre" },
            el("span", { class: "punto", style: "background:" + (COLORES[f.cadena] || GRIS) }),
            f.cadena,
            destacada ? el("span", { class: "etiqueta" }, "Más barato") : null,
            f.bioequivalente ? el("span", { class: "etiqueta bioeq", title: "Bioequivalente según la farmacia" }, "Bioequivalente") : null,
            f.receta ? el("span", { class: "etiqueta receta", title: "Requiere receta médica" }, "Receta") : null),
          el("span", { class: "precio" }, pesos.format(f.precio)),
          el("span", { class: "detalle" }, f.producto + (ahorro ? " · " + ahorro : "")),
          el("span", { class: "unidad" }, f.precio_unidad ? pesos.format(f.precio_unidad) + " c/u" : ""),
          f.cadena === "Salcobrand" && f.precio_lista && f.precio_lista !== f.precio
            ? el("span", { class: "detalle enlocal" }, "En el local: " + pesos.format(f.precio_lista)) : null),
        l && l.distancia_m <= RADIO_CERCA
          ? el("div", { class: "cerca" },
              el("span", {}, "A " + distancia(l.distancia_m) + " · " + l.direccion),
              el("a", { class: "ir", href: comoLlegar(l), target: "_blank", rel: "noopener" }, "Cómo llegar"))
          : el("div", { class: "cerca lejos" },
              l ? "El local más cercano está a " + distancia(l.distancia_m) + "."
                : "Sin locales en nuestro mapa: puede ser solo venta por internet.",
              f.url ? el("a", { class: "ir", href: f.url, target: "_blank", rel: "noopener" }, "Ver en su sitio") : null));
    };

    for (const g of orden) {
      const m = g[0];
      // genericos primero; las marcas van aparte y plegadas, porque mezclarlas
      // hace parecer que la diferencia de precio es entre farmacias
      const marcas = g.filter((f) => f.tipo === "marca");
      const genericos = marcas.length < g.length ? g.filter((f) => f.tipo !== "marca") : [];
      const principales = genericos.length ? genericos : g;
      const mejor = principales[0];
      // el ahorro se mide contra la siguiente opcion mas barata de OTRA cadena
      const siguiente = principales.find((f) => f.cadena !== mejor.cadena && f.precio > mejor.precio);
      const tarjeta = el("div", { class: "grupo" },
        el("h3", {}, m.principio_activo + " " + (m.mg < 1 ? Math.round(m.mg * 1000) + " mcg" : Number(m.mg) + " mg") + " · " + m.unidades + (m.forma === "liberacion prolongada" ? " comprimidos de liberación prolongada" : " comprimidos o cápsulas")));
      if (new Set(g.map((f) => f.cadena)).size === 1)
        tarjeta.append(el("p", { class: "unica" }, "Solo lo encontramos en " + m.cadena + (soloCerca ? " cerca de ti." : ".")));
      if (genericos.length) tarjeta.append(el("p", { class: "subtitulo" }, "Genéricos"));
      principales.forEach((f, i) => tarjeta.append(fila(f, i === 0 && principales.length > 1,
        i === 0 && siguiente ? "Ahorras " + pesos.format(siguiente.precio - f.precio) + " frente a " + siguiente.cadena : null)));
      if (genericos.length && marcas.length) {
        const veces = marcas[marcas.length - 1].precio / mejor.precio;
        tarjeta.append(el("details", { class: "marcas" },
          el("summary", {}, "Marcas (" + marcas.length + ") · desde " + pesos.format(marcas[0].precio)
            + (veces >= 2 ? " · hasta " + Math.round(veces) + " veces el genérico" : "")),
          ...marcas.map((f) => fila(f, false, null))));
      }
      tarjeta.append(el("button", { class: "reportar", type: "button", onclick: () => abrirReporte(g) },
        "¿Viste otro precio o no había? Avísanos"));
      caja.append(tarjeta);
    }

    // lo que no entra al comparador (jarabes, gotas, combinados, otras presentaciones)
    if (otros.length) {
      caja.append(el("details", { class: "grupo otros", ...(filas.length ? {} : { open: "" }) },
        el("summary", {}, "Otras presentaciones y productos (" + otros.length + ")"),
        ...otros.map((f) => fila(f, false, null)),
        el("button", { class: "reportar", type: "button", onclick: () => abrirReporte(otros) },
          "¿Viste otro precio o no había? Avísanos")));
    }
    marcarCadena();
  }

  // ---------- reportes de usuarios ----------

  function abrirReporte(productos) {
    const d = $("reporte");
    $("rProducto").replaceChildren(...productos.map((f) =>
      el("option", { value: f.producto_id }, f.cadena + " · " + f.producto + " · " + pesos.format(f.precio))));
    $("rEstado").textContent = "";
    $("rForm").reset();
    $("rPrecioCampo").hidden = false;
    d.showModal();
  }

  $("rTipo").addEventListener("change", () => { $("rPrecioCampo").hidden = $("rTipo").value !== "precio_distinto"; });
  $("rCancelar").addEventListener("click", () => $("reporte").close());
  $("rForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const tipo = $("rTipo").value;
    const precio = parseInt($("rPrecio").value.replace(/[^0-9]/g, ""), 10);
    if (tipo === "precio_distinto" && !(precio > 0)) { $("rEstado").textContent = "Escribe el precio que viste."; return; }
    $("rEnviar").disabled = true;
    try {
      await api("rpc/reportar", {
        p_producto_id: Number($("rProducto").value), p_tipo: tipo,
        p_precio: tipo === "precio_distinto" ? precio : null,
        p_comentario: $("rComentario").value.slice(0, 300) || null,
      });
      $("rEstado").textContent = "¡Gracias! Lo revisaremos para corregir el precio.";
      setTimeout(() => $("reporte").close(), 1600);
    } catch (err) {
      $("rEstado").textContent = "No pudimos guardar el reporte. Intenta de nuevo en un minuto.";
    } finally { $("rEnviar").disabled = false; }
  });

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
  $("soloLocal").addEventListener("change", pintarResultados);

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
