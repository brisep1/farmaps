(() => {
  const cfg = window.APP_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const pesos = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
  const COLORES = { "Cruz Verde": "#1a8f4c", "Ahumada": "#d6322c", "Salcobrand": "#1463b8", "Dr. Simi": "#7c3aed",
    "EcoFarmacias": "#0891b2", "Farmex": "#ea580c", "El Químico": "#be185d" };
  const GRIS = "#6b7280";
  const SANTIAGO = [-33.4489, -70.6693];
  const RADIO_CERCA = 5000;  // metros: hasta aqui un local cuenta como "cerca"
  // formas que no son comprimido ni capsula: no se comparan con ellos
  const NO_SOLIDO = /efervesc|polvo|sobre|jarabe|gotas|suspension|suposit|inyect|ampolla|crema|solucion|\bgel\b/;

  const estado = { pos: null, posEsReal: false, cadena: null, capa: null, yo: null,
                   cercanas: new Map(), turnos: new Map(), datos: null, mg: null, principios: [] };

  const nombre = cfg.NOMBRE || "Farmaps";
  document.title = nombre;
  // marca en dos tonos, como el "Farma|gül" original
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

  const sinTildes = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  // el MINSAL entrega todo en mayusculas: "AVENIDA RECOLETA 412" -> "Avenida Recoleta 412"
  const bonito = (s) => (s || "").toLowerCase().replace(/(^|[\s.\-/(])([a-záéíóúñ])/g, (m, a, b) => a + b.toUpperCase());
  const distancia = (m) => (m < 1000 ? Math.round(m / 10) * 10 + " m" : (m / 1000).toFixed(1).replace(".", ",") + " km");
  const hora = (iso) => new Date(iso).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", hour12: false });
  const haceDias = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const esDeNoche = () => { const h = new Date().getHours(); return h >= 21 || h < 8; };
  const enCelular = () => window.matchMedia("(max-width: 760px)").matches;
  const dosis = (mg) => (mg < 1 ? Math.round(mg * 1000) + " mcg" : Number(mg) + " mg");
  // abre la ruta desde donde esta la persona; a pie si queda a menos de 1,5 km
  const comoLlegar = (l) => "https://www.google.com/maps/dir/?api=1&destination=" + l.latitud + "," + l.longitud
    + (estado.posEsReal ? "&origin=" + estado.pos[0] + "," + estado.pos[1] : "")
    + (l.distancia_m != null && l.distancia_m < 1500 ? "&travelmode=walking" : "");

  function parecido(a, b) {  // distancia de edicion, para "¿quisiste decir…?"
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }

  // ---------- mapa ----------

  const mapa = L.map("mapa", { zoomControl: false }).setView(SANTIAGO, 12);
  L.control.zoom({ position: "bottomright" }).addTo(mapa);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(mapa);
  estado.capa = L.layerGroup().addTo(mapa);

  function fijarPosicion(lat, lng, real, origen) {
    estado.pos = [lat, lng];
    estado.posEsReal = real;
    if (estado.yo) estado.yo.remove();
    estado.yo = L.circleMarker(estado.pos, {
      radius: 8, color: "#fff", weight: 3, fillColor: "#2563eb", fillOpacity: 1,
    }).addTo(mapa).bindTooltip(real ? "Tu ubicación" : "Punto de partida");
    $("donde").replaceChildren(
      real ? "Usando tu ubicación."
        : origen === "mapa" ? "Usando el punto que marcaste en el mapa. "
        : "Mostramos el centro de Santiago. ",
      real ? null : el("button", { type: "button", class: "enlace", onclick: ubicarme }, "Usar mi ubicación"));
    cargarLocales();
    cargarCercanas();
  }

  // el local mas cercano de cada cadena (y el de turno, si hay uno cerca),
  // para mostrar distancia y ruta junto a cada precio
  async function cargarCercanas() {
    const pos = { lat: estado.pos[0], lng: estado.pos[1] };
    try {
      const [filas, turnos] = await Promise.all([
        api("rpc/cadenas_cercanas", pos),
        api("rpc/locales_cercanos", { ...pos, cadenas: null, solo_turno: true, limite: 25 }).catch(() => []),
      ]);
      estado.cercanas = new Map(filas.map((f) => [f.cadena, f]));
      estado.turnos = new Map();
      for (const t of turnos)
        if (t.distancia_m <= RADIO_CERCA && !estado.turnos.has(t.cadena)) estado.turnos.set(t.cadena, t);
    } catch (e) { estado.cercanas = new Map(); estado.turnos = new Map(); }
    pintarResultados();
  }

  function ubicarme() {
    if (!navigator.geolocation) return aviso("Tu navegador no entrega ubicación. Toca el mapa para fijar un punto.");
    navigator.geolocation.getCurrentPosition(
      (p) => { aviso(""); fijarPosicion(p.coords.latitude, p.coords.longitude, true); },
      () => aviso("No pudimos obtener tu ubicación. Revisa el permiso del navegador o toca el mapa para marcar dónde estás."),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  mapa.on("click", (e) => { aviso(""); fijarPosicion(e.latlng.lat, e.latlng.lng, false, "mapa"); });
  $("ubicarme").addEventListener("click", ubicarme);

  // ---------- locales cercanos ----------

  async function cargarLocales() {
    if (!estado.pos) return;
    let soloTurno = $("soloTurno").checked;
    const pedir = (turno) => api("rpc/locales_cercanos", {
      lat: estado.pos[0], lng: estado.pos[1],
      cadenas: estado.cadena ? [estado.cadena] : null,
      solo_turno: turno, limite: 25,
    });
    let locales, sinTurnoCerca = false;
    try {
      locales = await pedir(soloTurno);
      // elegiste una cadena y su local de turno mas cercano queda lejos (o no hay):
      // mejor mostrar sus locales cercanos que mandar el mapa a otra ciudad
      if (soloTurno && estado.cadena && (!locales.length || locales[0].distancia_m > RADIO_CERCA)) {
        const todos = await pedir(false);
        if (todos.length) { locales = todos; soloTurno = false; sinTurnoCerca = true; }
      }
    } catch (e) { return aviso(e.message); }

    estado.capa.clearLayers();
    const caja = $("locales");
    caja.replaceChildren();
    const titulo = (soloTurno ? "De turno ahora" : "Farmacias cercanas") + (estado.cadena ? " · " + estado.cadena : "");
    caja.append(el("h2", {}, titulo,
      estado.cadena ? el("button", { type: "button", class: "enlace quitar", onclick: () => { estado.cadena = null; marcarCadena(); cargarLocales(); } }, "Ver todas las cadenas") : null));

    if (sinTurnoCerca)
      caja.append(el("p", { class: "vacio" }, "Ningún local de " + estado.cadena + " está de turno cerca. Estos son sus locales más cercanos: revisa el horario antes de ir."));

    if (!locales.length) {
      caja.append(el("p", { class: "vacio" },
        soloTurno ? "No encontramos farmacias de turno" + (estado.cadena ? " de esta cadena" : "") + " cerca. Prueba quitando el filtro."
        : estado.cadena ? "No tenemos locales de " + estado.cadena + " en el mapa. Puede que venda solo por internet: revisa su sitio antes de ir."
                  : "No encontramos locales cerca de este punto."));
      return;
    }

    // con una cadena elegida, el mapa se acerca a su local mas cercano y a ti;
    // sin cadena, muestra los cinco locales mas cercanos
    const limites = [estado.pos];
    const enfoque = estado.cadena ? 1 : 5;
    let primero = null;
    locales.forEach((l, i) => {
      const color = COLORES[l.cadena] || GRIS;
      const marcador = L.circleMarker([l.latitud, l.longitud], {
        radius: l.de_turno ? 10 : 7, color: l.de_turno ? "#b45309" : "#fff", weight: l.de_turno ? 4 : 2,
        fillColor: color, fillOpacity: 1,
      }).addTo(estado.capa);
      marcador.bindPopup(el("div", {},
        el("strong", {}, bonito(l.nombre)),
        el("span", {}, bonito(l.direccion) + ", " + bonito(l.comuna)), el("br"),
        l.de_turno ? el("span", {}, "De turno hasta las " + hora(l.turno_fin)) : null,
        l.de_turno ? el("br") : null,
        el("a", { href: comoLlegar(l), target: "_blank", rel: "noopener" }, "Cómo llegar")));
      if (i < enfoque) limites.push([l.latitud, l.longitud]);
      if (i === 0) primero = marcador;

      if (i < 8) {
        caja.append(el("div", { class: "local" },
          el("div", { class: "titulo" },
            el("span", { class: "punto", style: "background:" + color }),
            el("span", {}, bonito(l.nombre)),
            l.de_turno ? el("span", { class: "etiqueta turno" }, "Turno hasta " + hora(l.turno_fin)) : null),
          el("div", { class: "dir" }, bonito(l.direccion) + ", " + bonito(l.comuna) + " · " + distancia(l.distancia_m)),
          el("div", { class: "acciones" },
            el("a", { href: comoLlegar(l), target: "_blank", rel: "noopener" }, "Cómo llegar"),
            l.telefono ? el("a", { href: "tel:" + l.telefono.replace(/[^+\d]/g, "") }, "Llamar") : null,
            el("button", { type: "button", class: "enlace", onclick: () => { mapa.setView([l.latitud, l.longitud], 16); marcador.openPopup(); verMapa(); } }, "Ver en el mapa"))));
      }
    });
    mapa.invalidateSize();
    mapa.fitBounds(limites, { padding: [60, 60], maxZoom: 17, animate: false });
    if (estado.cadena && primero) primero.openPopup();
  }

  // ---------- busqueda y comparacion ----------

  // "Paracetamol 500 mg" -> palabras ["paracetamol"], mg 500
  function interpretar(q) {
    let t = sinTildes(q).replace(/[*%,()_]/g, " ");
    let mg = null;
    const m = t.match(/(\d+(?:[.,]\d+)?)\s*(mcg|mg|gr|g)?\b/);
    if (m) {
      mg = parseFloat(m[1].replace(",", "."));
      if (m[2] === "mcg") mg /= 1000;
      else if (m[2] === "g" || m[2] === "gr") mg *= 1000;
      t = t.replace(m[0], " ");
    }
    return { palabras: t.split(/\s+/).filter((w) => w.length > 1), mg };
  }

  // en la base hay nombres con y sin tilde: cada vocal se busca como comodin
  const comodin = (w) => encodeURIComponent("*" + w.replace(/[aeioun]/g, "_") + "*");
  const reciente = () => "&fecha=gte." + haceDias(4);

  async function buscar(q, anotar = true) {
    const caja = $("resultados");
    aviso("");
    caja.replaceChildren(el("h2", {}, "Precios"), el("p", { class: "vacio" }, "Buscando…"));
    if (anotar) history.pushState({}, "", "?q=" + encodeURIComponent(q));
    document.title = q + " · " + nombre;

    const { palabras, mg } = interpretar(q);
    if (!palabras.length) {
      estado.datos = { q, filas: [], otros: [], sugeridos: [] };
      return pintarResultados();
    }
    let filas, otros, marca = null;
    try {
      [filas, otros] = await Promise.all([
        api("comparador?select=*&principio_activo=ilike." + comodin(palabras[0]) + reciente() + "&order=precio.asc&limit=500"),
        api("catalogo?select=*&" + palabras.map((w) => "producto=ilike." + comodin(w)).join("&")
          + "&medicamento_id=is.null" + reciente() + "&order=precio.asc&limit=200"),
      ]);
      filas = filas.filter((f) => sinTildes(f.principio_activo).includes(palabras[0]));
      otros = otros.filter((f) => palabras.every((w) => sinTildes(f.producto).includes(w)));
      // palabras que no son parte del principio activo ("jarabe", "forte"): filtran por nombre de producto
      const extras = palabras.slice(1).filter((w) => !filas.some((f) => sinTildes(f.principio_activo).includes(w)));
      if (extras.length) filas = filas.filter((f) => extras.every((w) => sinTildes(f.producto).includes(w)));

      // nada por principio activo: puede ser una marca ("tapsin"); se muestran todos
      // los precios de su medicamento, genericos incluidos
      if (!filas.length) {
        const deMarca = (await api("comparador?select=medicamento_id,principio_activo,producto&"
          + palabras.map((w) => "producto=ilike." + comodin(w)).join("&") + reciente() + "&limit=100"))
          .filter((f) => palabras.every((w) => sinTildes(f.producto).includes(w)));
        const ids = [...new Set(deMarca.map((f) => f.medicamento_id))].slice(0, 8);
        if (ids.length) {
          filas = await api("comparador?select=*&medicamento_id=in.(" + ids.join(",") + ")" + reciente() + "&order=precio.asc&limit=500");
          marca = { nombre: q, principios: [...new Set(deMarca.map((f) => f.principio_activo))] };
        }
      }
    } catch (e) { caja.replaceChildren(); return aviso(e.message); }

    // sin resultados: principios activos de nombre parecido
    let sugeridos = [];
    if (!filas.length && !otros.length) {
      const t = palabras[0];
      sugeridos = estado.principios
        .map((p) => [p, Math.min(parecido(t, p), parecido(t, p.slice(0, t.length)))])
        .filter(([p, d]) => d <= Math.max(1, Math.floor(t.length / 4)))
        .sort((a, b) => a[1] - b[1]).slice(0, 4).map(([p]) => p);
    }

    estado.datos = { q, filas, otros, marca, mgPedido: mg, sugeridos };
    estado.mg = null;  // la dosis elegida se recalcula con cada busqueda
    pintarResultados();
    // en celular, la pantalla baja hasta la dosis y el primer precio
    if (enCelular()) {
      const destino = caja.querySelector(".fichas, .grupo") || caja;
      $("panel").scrollTop += destino.getBoundingClientRect().top - $("panel").getBoundingClientRect().top - 8;
    }
  }

  function pintarResultados() {
    if (!estado.datos) return;
    const { q, marca, mgPedido, sugeridos } = estado.datos;
    const caja = $("resultados");
    const soloCerca = $("soloLocal").checked;
    const noche = esDeNoche() || $("soloTurno").checked;
    const local = (f) => estado.cercanas.get(f.cadena);
    const cerca = (f) => { const l = local(f); return l && l.distancia_m <= RADIO_CERCA; };
    const filtrar = (lista) => (soloCerca ? lista.filter(cerca) : lista);

    // efervescentes, sobres y similares no se comparan con comprimidos
    const solidas = estado.datos.filas.filter((f) => !NO_SOLIDO.test(sinTildes(f.producto)));
    const todasOtras = estado.datos.otros.concat(estado.datos.filas.filter((f) => NO_SOLIDO.test(sinTildes(f.producto))))
      .sort((a, b) => a.precio - b.precio);
    const filas = filtrar(solidas);
    let otros = filtrar(todasOtras);
    const ocultas = solidas.length + todasOtras.length - filas.length - otros.length;

    caja.replaceChildren(el("h2", {}, "Precios"));
    if (!solidas.length && !todasOtras.length) {
      caja.append(el("p", { class: "vacio" }, "No tenemos precios para “" + q + "”."));
      if (sugeridos && sugeridos.length) {
        caja.append(el("p", { class: "sugeridos" }, "¿Quisiste decir ",
          ...sugeridos.flatMap((s, i) => [i ? ", " : "", el("button", { type: "button", class: "enlace", onclick: () => { $("q").value = s; buscar(s); } }, s)]),
          "?"));
      } else {
        caja.append(el("p", { class: "vacio" }, "Prueba con el principio activo que aparece en la caja (por ejemplo, “ácido acetilsalicílico” en vez de Aspirina). Por ahora seguimos "
          + (estado.principios.length || "unos 40") + " medicamentos de uso frecuente."));
      }
      return;
    }
    const ultima = solidas.concat(todasOtras).reduce((a, f) => (f.fecha > a ? f.fecha : a), "");
    caja.append(el("p", { class: "fecha" }, "Precios web revisados el " + ultima.split("-").reverse().join("-") + "."));
    if (marca && marca.principios.length)
      caja.append(el("p", { class: "nota" }, "“" + marca.nombre + "” es una marca de " + marca.principios.join(" o ")
        + ". Estos son todos los precios de ese medicamento, con sus genéricos."));
    if (noche)
      caja.append(el("p", { class: "nota noche" }, "De noche muchos locales cierran: marcamos los que están de turno."));
    if (ocultas) {
      caja.append(el("p", { class: "ocultas" },
        "Ocultamos " + ocultas + (ocultas === 1 ? " opción" : " opciones") + " sin local a menos de 5 km. ",
        el("button", { type: "button", class: "enlace", onclick: () => { $("soloLocal").checked = false; pintarResultados(); } }, "Mostrar todas")));
    }
    if (!filas.length && !otros.length) {
      caja.append(el("p", { class: "vacio" }, "Ninguna farmacia con local cerca lo tiene. Mira todas las opciones para comprar por internet."));
      return;
    }

    const porMedicamento = new Map();
    for (const f of filas) {
      if (!porMedicamento.has(f.medicamento_id)) porMedicamento.set(f.medicamento_id, []);
      porMedicamento.get(f.medicamento_id).push(f);
    }
    const cadenasDe = (g) => new Set(g.map((x) => x.cadena)).size;
    let grupos = [...porMedicamento.values()];

    // selector de dosis: evita una lista de doce presentaciones mezcladas
    const mgs = [...new Set(grupos.map((g) => Number(g[0].mg)))].sort((a, b) => a - b);
    if (mgs.length > 1) {
      if (estado.mg == null) {
        const pedida = mgPedido != null && (mgs.includes(mgPedido) ? mgPedido : mgs.includes(mgPedido / 1000) ? mgPedido / 1000 : null);
        const peso = (mg) => grupos.filter((g) => Number(g[0].mg) === mg).reduce((s, g) => s + cadenasDe(g) * 100 + g.length, 0);
        estado.mg = pedida != null && pedida !== false ? pedida : mgs.slice().sort((a, b) => peso(b) - peso(a))[0];
      }
      const ficha = (valor, texto) => el("button", {
        type: "button", class: "ficha" + (estado.mg === valor ? " activa" : ""), "aria-pressed": String(estado.mg === valor),
        onclick: () => { estado.mg = valor; pintarResultados(); },
      }, texto);
      caja.append(el("div", { class: "fichas", role: "group", "aria-label": "Dosis" },
        ...mgs.map((mg) => ficha(mg, dosis(mg))), ficha("todas", "Todas")));
      if (estado.mg !== "todas") grupos = grupos.filter((g) => Number(g[0].mg) === estado.mg);
    }
    // con dosis pedida ("paracetamol 500"), las otras presentaciones tambien se filtran por ese numero
    if (mgPedido != null) {
      const n = new RegExp("(^|\\D)" + String(mgPedido).replace(".", "[.,]") + "(\\D|$)");
      const conDosis = otros.filter((f) => n.test(f.producto));
      if (conDosis.length) otros = conDosis;
    }
    grupos.sort((a, b) => a[0].mg - b[0].mg || cadenasDe(b) - cadenasDe(a) || a[0].unidades - b[0].unidades);

    // cada opcion: el precio y, debajo, el local mas cercano con sus dos acciones
    const fila = (f, destacada, ahorro) => {
      const turno = noche ? estado.turnos.get(f.cadena) : null;
      const l = turno || local(f);
      const hayCerca = l && l.distancia_m <= RADIO_CERCA;
      return el("div", { class: "opcion" + (destacada ? " barata" : "") },
        el("div", { class: "cadena", "data-cadena": f.cadena },
          el("span", { class: "nombre" },
            el("span", { class: "punto", style: "background:" + (COLORES[f.cadena] || GRIS) }),
            f.cadena,
            destacada ? el("span", { class: "etiqueta" }, "Más barato") : null,
            f.bioequivalente ? el("span", { class: "etiqueta bioeq", title: "Bioequivalente según la farmacia" }, "Bioequivalente") : null),
          el("span", { class: "precio" }, pesos.format(f.precio)),
          el("span", { class: "detalle" }, f.producto + (ahorro ? " · " + ahorro : "")),
          el("span", { class: "unidad" }, f.precio_unidad ? pesos.format(f.precio_unidad) + " c/u" : ""),
          f.cadena === "Salcobrand" && f.precio_lista && f.precio_lista !== f.precio
            ? el("span", { class: "detalle enlocal" }, "En el local: " + pesos.format(f.precio_lista)) : null),
        hayCerca
          ? el("div", { class: "cerca" },
              el("span", { class: "donde-local" },
                turno ? el("span", { class: "etiqueta turno" }, "De turno hasta " + hora(turno.turno_fin)) : null,
                " A " + distancia(l.distancia_m) + " · " + bonito(l.direccion),
                noche && !turno ? el("span", { class: "cerrado" }, " · Puede estar cerrado ahora") : null),
              el("span", { class: "botones" },
                el("button", { type: "button", class: "ir secundaria", onclick: () => elegirCadena(f.cadena) }, "Mapa"),
                el("a", { class: "ir", href: comoLlegar(l), target: "_blank", rel: "noopener" }, "Cómo llegar")))
          : el("div", { class: "cerca lejos" },
              el("span", { class: "donde-local" }, l ? "El local más cercano está a " + distancia(l.distancia_m) + "."
                : "Sin locales en nuestro mapa: puede ser solo venta por internet."),
              f.url ? el("span", { class: "botones" }, el("a", { class: "ir secundaria", href: f.url, target: "_blank", rel: "noopener" }, "Ver en su sitio")) : null));
    };
    // de cada cadena, solo su opcion mas barata (la lista ya viene ordenada por precio)
    const unaPorCadena = (lista) => { const vistas = new Set(); return lista.filter((f) => !vistas.has(f.cadena) && vistas.add(f.cadena)); };

    for (const g of grupos) {
      const m = g[0];
      // genericos primero; las marcas van aparte y plegadas, porque mezclarlas
      // hace parecer que la diferencia de precio es entre farmacias
      const marcas = g.filter((f) => f.tipo === "marca");
      const genericos = marcas.length < g.length ? unaPorCadena(g.filter((f) => f.tipo !== "marca")) : [];
      const principales = genericos.length ? genericos : g;
      const mejor = principales[0];
      // el ahorro se mide contra la siguiente opcion mas barata de OTRA cadena
      const siguiente = principales.find((f) => f.cadena !== mejor.cadena && f.precio > mejor.precio);
      const tarjeta = el("div", { class: "grupo" },
        el("h3", {}, m.principio_activo[0].toUpperCase() + m.principio_activo.slice(1) + " " + dosis(m.mg) + " · " + m.unidades
          + (m.forma === "liberacion prolongada" ? " comprimidos de liberación prolongada" : " comprimidos o cápsulas"),
          g.some((f) => f.receta) ? el("span", { class: "etiqueta receta" }, "Requiere receta") : null));
      if (cadenasDe(g) === 1)
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
      caja.append(el("details", { class: "grupo otros", ...(grupos.length ? {} : { open: "" }) },
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
      el("option", { value: f.producto_id }, f.cadena + " · " + pesos.format(f.precio) + " · " + f.producto)));
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

  function verMapa() {
    if (enCelular()) $("panel").scrollTo({ top: 0, behavior: "smooth" });
    $("mapa").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function elegirCadena(cadena) {
    estado.cadena = cadena;  // el filtro se quita con "Ver todas las cadenas"
    marcarCadena();
    cargarLocales();
    verMapa();
  }

  $("buscador").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = $("q").value.trim();
    if (q) { estado.cadena = null; buscar(q); cargarLocales(); }
  });
  $("soloTurno").addEventListener("change", () => { cargarLocales(); pintarResultados(); });
  $("soloLocal").addEventListener("change", pintarResultados);

  // ---------- inicio ----------

  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_KEY) {
    aviso("Falta configurar la clave pública de Supabase en config.js. Sin ella no se pueden cargar precios ni farmacias.");
    return;
  }

  // de noche lo urgente es que este abierta: el mapa parte con las de turno
  if (esDeNoche()) $("soloTurno").checked = true;

  // la busqueda vive en la direccion (?q=losartan): se puede compartir y volver atras
  function leerDireccion() {
    const q = (new URLSearchParams(location.search).get("q") || "").trim();
    $("q").value = q;
    if (q) buscar(q, false);
    else { estado.datos = null; $("resultados").replaceChildren(); document.title = nombre; }
  }
  window.addEventListener("popstate", leerDireccion);

  api("medicamentos?select=principio_activo").then((ms) => {
    estado.principios = [...new Set(ms.map((m) => m.principio_activo))].sort();
    estado.principios.forEach((p) => $("sugerencias").append(el("option", { value: p })));
  }).catch(() => {});

  // se parte en el centro de Santiago; la ubicacion real solo se pide sola si
  // el permiso ya estaba dado, para no abrir con una ventana de permiso sin contexto
  fijarPosicion(SANTIAGO[0], SANTIAGO[1], false);
  if (navigator.permissions)
    navigator.permissions.query({ name: "geolocation" }).then((p) => { if (p.state === "granted") ubicarme(); }).catch(() => {});
  leerDireccion();
})();
