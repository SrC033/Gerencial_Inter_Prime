// ============================================================
// RESUMEN EJECUTIVO - GRUPO GSN
// Dashboard AUTÓNOMO (obtiene sus propios datos desde Apps Script)
// ============================================================

// ============================================================
// CONFIGURACIÓN DEL APPS SCRIPT
// ============================================================
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwTPkbv-0l9giFB_sXY5wpWdSD7WFsXKuBApFmjHBASBPkCo-m33Poun7EHvpaUKPbWCg/exec';
const SCRIPT_URL_FUEL = SCRIPT_URL + '?tipo=fuel';
const CLAVE_CARPETA = 'GSN-DASHBOARD-2026';
const AUTO_REFRESH_MIN = 5;

const isStandalone = window.parent === window;
console.log(isStandalone
    ? '🔓 MODO AUTÓNOMO · Consultando Apps Script directamente'
    : '🔗 MODO EMBEBIDO · Esperando datos del main.html');

// ============================================================
// DATOS GLOBALES
// ============================================================
let DATA = [];
let DATA_FUEL = [];
let lastUpdateTime = null;
let lastUpdateFuelTime = null;
let isFuelView = false;
let isRendering = false;
let pendingUpdate = false;

let fuelChartInstance = null;
let generalChartInstance = null;
let clientChartInstance = null;
let compareChartInstance = null;
let lostChartInstance = null;
let discrepancyChartInstance = null;

// ============================================================
// CARRUSEL
// ============================================================
let carouselIndex = 0;
let carouselAutoTimer = null;
const CAROUSEL_INTERVAL = 8000;
const CAROUSEL_TITLES = [
    'Distribución Fuel Oil',
    'Rendimiento General',
    'Top Clientes',
    'Mes Actual vs Mes Anterior',
    'Clientes que Dejaron de Consumir',
    'Detector de Discrepancias'
];

function initCarousel() {
    var track = document.getElementById('carouselTrack');
    var dotsContainer = document.getElementById('carouselDots');
    var prevBtn = document.getElementById('carouselPrev');
    var nextBtn = document.getElementById('carouselNext');
    if (!track || !dotsContainer) return;

    var slides = track.querySelectorAll('.carousel-slide');
    var total = slides.length;

    dotsContainer.innerHTML = '';
    for (var i = 0; i < total; i++) {
        var dot = document.createElement('button');
        dot.className = 'carousel-dot' + (i === 0 ? ' active' : '');
        dot.setAttribute('data-index', i);
        dot.setAttribute('aria-label', 'Ir a gráfica ' + (i + 1));
        dot.onclick = (function(idx) { return function() { goToSlide(idx); }; })(i);
        dotsContainer.appendChild(dot);
    }
    if (prevBtn) prevBtn.onclick = function() { goToSlide(carouselIndex - 1); };
    if (nextBtn) nextBtn.onclick = function() { goToSlide(carouselIndex + 1); };

    goToSlide(0, true);
    startCarouselAuto();

    var panel = document.querySelector('.carousel-panel');
    if (panel) {
        panel.addEventListener('mouseenter', stopCarouselAuto);
        panel.addEventListener('mouseleave', startCarouselAuto);
    }
    window.addEventListener('beforeunload', stopCarouselAuto);
}

function goToSlide(index, silent) {
    var track = document.getElementById('carouselTrack');
    if (!track) return;
    var slides = track.querySelectorAll('.carousel-slide');
    var total = slides.length;
    if (total === 0) return;
    if (index < 0) index = total - 1;
    if (index >= total) index = 0;
    carouselIndex = index;
    track.style.transform = 'translateX(-' + (index * 100) + '%)';
    document.querySelectorAll('.carousel-dot').forEach(function(d, i) {
        d.classList.toggle('active', i === index);
    });
    var subtitle = document.getElementById('carouselSubtitle');
    if (subtitle) subtitle.textContent = CAROUSEL_TITLES[index] || 'Análisis Visual';
    if (!silent) startCarouselAuto();
}

function startCarouselAuto() {
    if (carouselAutoTimer) clearInterval(carouselAutoTimer);
    carouselAutoTimer = setInterval(function() { goToSlide(carouselIndex + 1, true); }, CAROUSEL_INTERVAL);
}

function stopCarouselAuto() {
    if (carouselAutoTimer) { clearInterval(carouselAutoTimer); carouselAutoTimer = null; }
}

// ============================================================
// AUXILIARES
// ============================================================
const N = new Intl.NumberFormat('es-NI', { maximumFractionDigits: 0 });
const M = new Intl.NumberFormat('es-NI', { style: 'currency', currency: 'NIO', maximumFractionDigits: 0 });
const t = function(v) { return String(v ?? '').trim(); };

// Parser numérico robusto: soporta coma decimal y punto de miles
const n = function(v) {
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    if (typeof v === 'string') {
        var s = v.trim().replace(/\s/g, '');
        if (!s) return 0;
        // Detectar formato: si tiene coma Y punto → punto=miles, coma=decimal
        if (s.includes(',') && s.includes('.')) {
            s = s.replace(/\./g, '').replace(',', '.');
        } else if (s.includes(',')) {
            s = s.replace(',', '.');
        }
        var parsed = parseFloat(s);
        return isNaN(parsed) ? 0 : parsed;
    }
    return 0;
};

const fd = function(v) {
    if (!v) return 'Sin fecha';
    var str = String(v).trim();
    var match = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) {
        var year = parseInt(match[1]);
        if (year < 1900) return 'Fecha invalida';
        return match[3] + '/' + match[2] + '/' + match[1];
    }
    var d = new Date(str);
    if (!isNaN(d.getTime())) {
        var year = d.getFullYear();
        if (year < 1900) return 'Fecha invalida';
        var dd = String(d.getDate()).padStart(2, '0');
        var mm = String(d.getMonth() + 1).padStart(2, '0');
        return dd + '/' + mm + '/' + year;
    }
    return str;
};

const sum = function(a, k) { return a.reduce(function(s, o) { return s + n(o[k]); }, 0); };

const COLUMN_LETTERS = {
    'fecha': 'B', 'cliente': 'C', 'combustible': 'D', 'destino': 'E',
    'solicitado': 'H', 'despachado': 'R', 'subtotalVenta': 'AC',
    'margenBruto': 'AE', 'facturaGSN': 'AD', 'conductor': 'S',
    'placaEntrega': 'Q', 'flota': 'P', 'pedidoPuma': 'I'
};

const MESES_ORDER = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];

function getLocation(rowIndex, fieldName) {
    var colLetter = COLUMN_LETTERS[fieldName] || '?';
    return { row: rowIndex, col: colLetter, cell: colLetter + rowIndex };
}

// Sanitizador para prevenir XSS en strings inyectados
function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, function(c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

// ============================================================
// TOAST
// ============================================================
let toastTimeout = null;
function showToast(message, type, duration) {
    var toast = document.getElementById('toast');
    var icon = document.getElementById('toastIcon');
    var msg = document.getElementById('toastMessage');
    if (!toast || !icon || !msg) return;
    toast.className = 'toast';
    icon.textContent = type === 'success' ? '✅' : type === 'error' ? '❌' : '⏳';
    msg.textContent = message;
    if (type === 'success') toast.classList.add('success');
    else if (type === 'error') toast.classList.add('error');
    else if (type === 'loading') toast.classList.add('loading');
    toast.classList.add('show');
    if (toastTimeout) clearTimeout(toastTimeout);
    if (duration) toastTimeout = setTimeout(hideToast, duration);
}
function hideToast() {
    var toast = document.getElementById('toast');
    if (!toast) return;
    toast.classList.remove('show');
    if (toastTimeout) { clearTimeout(toastTimeout); toastTimeout = null; }
}

// ============================================================
// TOOLTIP
// ============================================================
function showInfoTooltip(title, subtitle, content, extraData) {
    var tooltip = document.getElementById('infoTooltip');
    var titleEl = document.getElementById('ttTitle');
    var bodyEl = document.getElementById('ttContent');
    if (!tooltip || !titleEl || !bodyEl) return;

    titleEl.textContent = title || 'Informacion';
    var html = '';
    if (subtitle) html += '<div style="color:var(--txt-muted);font-size:12px;margin-bottom:6px;">' + esc(subtitle) + '</div>';
    if (content) html += '<div>' + content + '</div>';

    if (extraData) {
        if (extraData.locations && extraData.locations.length > 0) {
            html += '<div class="location-box"><div style="margin-bottom:4px;"><span class="loc-label" style="color:var(--neon-amber);font-weight:600;">📍 Ubicacion en la hoja de calculo</span></div><div class="error-list">';
            extraData.locations.slice(0, 15).forEach(function(loc) {
                html += '<div class="err-item"><span class="err-location">Fila ' + esc(loc.row) + '</span><span class="err-detail">Columna <strong style="color:var(--neon-teal);">' +
                    esc(loc.col) + '</strong> → ' + esc(loc.description) + '</span></div>';
            });
            if (extraData.locations.length > 15) {
                html += '<div class="err-item"><span class="err-location">...</span><span class="err-detail">+' + (extraData.locations.length - 15) + ' mas</span></div>';
            }
            html += '</div></div>';
        }
        html += '<div class="section"><div class="section-title">🔧 Detalles tecnicos</div>';
        if (extraData.formula) html += '<div class="code-block">' + esc(extraData.formula) + '</div>';
        if (extraData.explanation) html += '<div style="margin-top:4px;color:var(--txt-muted);font-size:11px;">' + esc(extraData.explanation) + '</div>';
        if (extraData.fields && extraData.fields.length > 0) {
            html += '<div style="margin-top:6px;display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:11px;">';
            extraData.fields.forEach(function(f) {
                html += '<div><span style="color:var(--txt-muted);">' + esc(f.label) + ':</span> <span style="color:var(--neon-teal);font-weight:500;">' + esc(f.value) + '</span></div>';
            });
            html += '</div>';
        }
        if (extraData.solution) {
            html += '<div style="margin-top:8px;padding:8px 12px;background:rgba(15,240,212,0.04);border-radius:var(--radius-sm);border-left:3px solid var(--neon-teal);"><span style="color:var(--neon-amber);font-weight:600;">💡 Solucion:</span><span style="color:var(--txt-primary);font-size:11px;">' + esc(extraData.solution) + '</span></div>';
        }
        if (extraData.error) {
            html += '<div style="margin-top:8px;padding:8px 12px;background:rgba(255,84,112,0.04);border-radius:var(--radius-sm);border-left:3px solid var(--neon-red);"><span style="color:var(--neon-red);font-weight:600;">❌ Error identificado:</span><span style="color:var(--txt-primary);font-size:11px;">' + esc(extraData.error) + '</span></div>';
        }
        html += '</div>';
    }
    var timeStr = lastUpdateTime ? lastUpdateTime.toLocaleString('es-NI', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '--/--/---- --:--:--';
    html += '<div style="margin-top:10px;padding-top:8px;border-top:1px solid rgba(15,240,212,0.08);font-size:9px;color:var(--txt-muted);">🔄 Datos actualizados: ' + timeStr + '</div>';

    bodyEl.innerHTML = html;
    tooltip.classList.add('visible');
}

function hideInfoTooltip() {
    var el = document.getElementById('infoTooltip');
    if (el) el.classList.remove('visible');
}

document.addEventListener('click', function(e) {
    var tooltip = document.getElementById('infoTooltip');
    if (!tooltip || !tooltip.classList.contains('visible')) return;
    if (!tooltip.contains(e.target) &&
        !e.target.closest('.kpi-item') &&
        !e.target.closest('.panel') &&
        !e.target.closest('.alert') &&
        !e.target.closest('.source-badge')) {
        hideInfoTooltip();
    }
});

document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') hideInfoTooltip();
    if (e.key === 'ArrowLeft') goToSlide(carouselIndex - 1);
    if (e.key === 'ArrowRight') goToSlide(carouselIndex + 1);
});

// ============================================================
// FILTROS
// ============================================================
var state = { period: 'Todos', client: 'Todos', fuel: 'Todos', fleet: 'Todas', q: '', page: 1 };
var activeView = 'summary';

function getUniqueValues(data, key) {
    if (!data || !Array.isArray(data) || data.length === 0) return [];
    var values = new Set();
    data.forEach(function(item) {
        var val = t(item[key]);
        if (val && val !== '' && val !== 'null' && val !== 'undefined') values.add(val);
    });
    return Array.from(values).sort();
}

function getUniquePeriods(data, dataFuel) {
    var periods = new Set();
    function addFrom(arr) {
        if (!arr || !Array.isArray(arr)) return;
        arr.forEach(function(item) {
            var mes = t(item.mes);
            if (mes && mes !== '' && mes !== 'null' && mes !== 'undefined') periods.add(mes.toUpperCase());
        });
    }
    addFrom(data); addFrom(dataFuel);
    return Array.from(periods).sort(function(a, b) { return MESES_ORDER.indexOf(a) - MESES_ORDER.indexOf(b); });
}

function fill(id, vals, all) {
    var e = document.getElementById(id);
    if (!e) return;
    var currentVal = e.value;
    var options = all ? [all] : [];
    vals.forEach(function(v) { if (v && v !== '' && v !== 'null' && v !== 'undefined') options.push(v); });
    e.innerHTML = options.map(function(v) { return '<option value="' + esc(v) + '">' + esc(v) + '</option>'; }).join('');
    if (currentVal && Array.from(e.options).some(function(o) { return o.value === currentVal; })) {
        e.value = currentVal;
    } else if (options.length > 0) {
        e.selectedIndex = 0;
    }
}

function refillFilters() {
    var current = Object.assign({}, state);
    if (DATA && DATA.length > 0) {
        fill('period', getUniquePeriods(DATA, DATA_FUEL), 'Todos');
        fill('client', getUniqueValues(DATA, 'cliente'), 'Todos');
        fill('fuel', getUniqueValues(DATA, 'combustible'), 'Todos');
        fill('fleet', getUniqueValues(DATA, 'flota'), 'Todas');

        ['period', 'client', 'fuel', 'fleet'].forEach(function(id) {
            var e = document.getElementById(id);
            if (e && current[id] && Array.from(e.options).some(function(x) { return x.value === current[id]; })) {
                e.value = current[id];
            } else if (e && e.options.length > 0) {
                e.selectedIndex = 0;
                state[id] = e.value;
            }
        });
    }
}

function filtered() {
    if (isFuelView) return filteredFuel();
    return DATA.filter(function(o) {
        if (state.period !== 'Todos') {
            var mesRegistro = t(o.mes).toUpperCase();
            if (mesRegistro !== state.period.toUpperCase()) return false;
        }
        if (state.client !== 'Todos' && t(o.cliente) !== state.client) return false;
        if (state.fuel !== 'Todos' && t(o.combustible) !== state.fuel) return false;
        if (state.fleet !== 'Todas' && t(o.flota) !== state.fleet) return false;
        if (state.q) {
            var searchFields = [o.cliente, o.conductor, o.placaEntrega, o.pedidoPuma, o.facturaGSN, o.combustible, o.flota];
            var match = searchFields.some(function(v) { return v && String(v).toLowerCase().includes(state.q); });
            if (!match) return false;
        }
        return true;
    });
}

function filteredFuel() {
    var data = DATA_FUEL;
    if (!data || data.length === 0) return [];
    return data.filter(function(o) {
        if (state.period !== 'Todos' && t(o.mes).toUpperCase() !== state.period.toUpperCase()) return false;
        if (state.client !== 'Todos' && t(o.cliente) !== state.client) return false;
        if (state.fuel !== 'Todos' && t(o.producto) !== state.fuel) return false;
        if (state.fleet !== 'Todas' && t(o.flota) !== state.fleet) return false;
        return true;
    });
}

var groupBy = function(a, key) {
    var m = {};
    a.forEach(function(o) {
        var label = t(o[key]) || 'Sin registrar';
        if (!m[label]) m[label] = [];
        m[label].push(o);
    });
    return Object.entries(m);
};

function getSourceBadgeHTML() {
    var timeStr = lastUpdateTime ? lastUpdateTime.toLocaleTimeString('es-NI', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '--:--:--';
    return '<span class="source-badge" onclick="event.stopPropagation();showInfoTooltip(\'Fuente de datos\', \'Google Sheets\', \'Los datos se obtienen automaticamente desde Google Sheets.\', { fields: [{ label: \'Ultima actualizacion\', value: \'' + timeStr + '\' }] })">Google Sheets · ' + timeStr + '</span>';
}

function getFuelSourceBadgeHTML() {
    var timeStr = lastUpdateFuelTime ? lastUpdateFuelTime.toLocaleTimeString('es-NI', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '--:--:--';
    return '<span class="source-badge" style="border-color:rgba(255,183,77,0.3);color:var(--neon-amber);background:rgba(255,183,77,0.06);" onclick="event.stopPropagation();showInfoTooltip(\'Fuente de datos Fuel Oil\', \'Google Sheets\', \'Los datos de Fuel Oil se obtienen del archivo FUEL OIL 2026.xlsx.\', { fields: [{ label: \'Ultima actualizacion\', value: \'' + timeStr + '\' }] })">Fuel Oil · ' + timeStr + '</span>';
}

function showKPIInfo(label, value, pct) {
    var kpiMap = {
        'Volumen Total': { formula: 'Suma(Volumen)', explanation: 'Suma total de galones de Fuel Oil transportados en el periodo seleccionado.' },
        'Venta Total': { formula: 'Suma(SUB TOTAL VENTA)', explanation: 'Suma total de ventas de Fuel Oil en el periodo seleccionado.' },
        'Margen Fuel': { formula: 'Suma(MARGEN)', explanation: 'Suma total del margen de Fuel Oil.' },
        'Viajes': { formula: 'COUNT(registros)', explanation: 'Numero total de viajes de Fuel Oil registrados.' },
        'Volumen solicitado': { formula: 'Suma(Solicitado)', explanation: 'Suma total de galones solicitados por los clientes.' },
        'Volumen despachado': { formula: 'Suma(Despachado)', explanation: 'Suma total de galones efectivamente entregados.' },
        'Ventas General': { formula: 'Suma(Subtotal Venta)', explanation: 'Suma total de los ingresos por ventas.' },
        'Margen bruto General': { formula: 'Suma(Margen Bruto)', explanation: 'Suma total del margen bruto.' }
    };
    var info = kpiMap[label] || { formula: 'Sin informacion', explanation: 'Este KPI se calcula a partir de los datos de la hoja de calculo.' };
    var extraFields = [{ label: 'Valor', value: value }];
    if (pct !== undefined && pct !== null && pct !== '') extraFields.push({ label: 'Porcentaje', value: pct });
    showInfoTooltip('KPI: ' + label, 'Valor actual: ' + value + (pct ? ' (' + pct + ')' : ''), '', {
        formula: info.formula, explanation: info.explanation, fields: extraFields
    });
}

// ============================================================
// DETECTOR DE DISCREPANCIAS
// ============================================================
function detectDiscrepancies(a) {
    var discrepancies = [];
    a.forEach(function(o) {
        var venta = n(o.subtotalVenta);
        var margen = n(o.margenBruto);
        var solicitado = n(o.solicitado);
        var despachado = n(o.despachado);

        if (venta > 0 && margen > venta) {
            discrepancies.push({ tipo: 'Margen > Venta', row: o._rowIndex || 0, cliente: t(o.cliente), detalle: 'Margen ' + M.format(margen) + ' > Venta ' + M.format(venta), valor: margen - venta, severity: 'alta' });
        }
        if (venta === 0 && despachado > 0) {
            discrepancies.push({ tipo: 'Venta en 0', row: o._rowIndex || 0, cliente: t(o.cliente), detalle: 'Despachado ' + N.format(despachado) + ' gal sin venta registrada', valor: 0, severity: 'alta' });
        }
        if (venta > 0 && margen < -venta * 0.5) {
            discrepancies.push({ tipo: 'Margen negativo alto', row: o._rowIndex || 0, cliente: t(o.cliente), detalle: 'Margen ' + M.format(margen) + ' (' + ((margen / venta) * 100).toFixed(1) + '% de venta)', valor: margen, severity: 'media' });
        }
        if (solicitado > 0 && despachado > solicitado * 1.1) {
            discrepancies.push({ tipo: 'Despacho excedido', row: o._rowIndex || 0, cliente: t(o.cliente), detalle: 'Despachado ' + N.format(despachado) + ' > Solicitado ' + N.format(solicitado), valor: despachado - solicitado, severity: 'media' });
        }
    });
    return discrepancies;
}

// ============================================================
// DETECTOR: CLIENTES QUE DEJARON DE CONSUMIR
// ============================================================
function detectLostClients(a) {
    var orderMeses = MESES_ORDER;
    var monthlyByClient = {};
    var allMonths = new Set();

    a.forEach(function(o) {
        var mes = t(o.mes).toUpperCase();
        if (!mes || orderMeses.indexOf(mes) === -1) return;
        var cliente = t(o.cliente) || 'Sin registrar';
        if (!monthlyByClient[mes]) monthlyByClient[mes] = {};
        if (!monthlyByClient[mes][cliente]) monthlyByClient[mes][cliente] = { ventas: 0, volumen: 0, viajes: 0 };
        monthlyByClient[mes][cliente].ventas += n(o.subtotalVenta);
        monthlyByClient[mes][cliente].volumen += n(o.despachado);
        monthlyByClient[mes][cliente].viajes++;
        allMonths.add(mes);
    });

    var mesesOrdenados = orderMeses.filter(function(m) { return allMonths.has(m); });
    if (mesesOrdenados.length < 2) return { lost: [], mesActual: null, mesAnterior: null };

    var mesActual = mesesOrdenados[mesesOrdenados.length - 1];
    var mesAnterior = mesesOrdenados[mesesOrdenados.length - 2];

    var allClients = new Set();
    Object.keys(monthlyByClient).forEach(function(mes) {
        Object.keys(monthlyByClient[mes]).forEach(function(c) { allClients.add(c); });
    });

    var lost = [];
    allClients.forEach(function(cliente) {
        var enActual = monthlyByClient[mesActual] && monthlyByClient[mesActual][cliente];
        var enAnterior = monthlyByClient[mesAnterior] && monthlyByClient[mesAnterior][cliente];

        var historico = [];
        mesesOrdenados.forEach(function(m) {
            if (m === mesActual) return;
            if (monthlyByClient[m] && monthlyByClient[m][cliente]) historico.push(monthlyByClient[m][cliente].ventas);
        });

        var promedioHistorico = historico.length > 0 ? historico.reduce(function(a, b) { return a + b; }, 0) / historico.length : 0;
        var ventaActual = enActual ? enActual.ventas : 0;
        var ventaAnterior = enAnterior ? enAnterior.ventas : 0;

        if (ventaAnterior > 0 && ventaActual === 0) {
            lost.push({ cliente: cliente, mesAnterior: mesAnterior, mesActual: mesActual, ventaAnterior: ventaAnterior, ventaActual: 0, promedio: promedioHistorico, caida: 100, tipo: 'Dejó de consumir', severity: 'alta' });
        } else if (promedioHistorico > 0 && ventaActual > 0 && ventaActual < promedioHistorico * 0.3) {
            var caida = ((promedioHistorico - ventaActual) / promedioHistorico) * 100;
            lost.push({ cliente: cliente, mesAnterior: mesAnterior, mesActual: mesActual, ventaAnterior: ventaAnterior, ventaActual: ventaActual, promedio: promedioHistorico, caida: caida, tipo: 'Caída drástica', severity: 'media' });
        } else if (ventaAnterior > 0 && ventaActual > 0) {
            var caidaMes = ((ventaAnterior - ventaActual) / ventaAnterior) * 100;
            if (caidaMes > 50) {
                lost.push({ cliente: cliente, mesAnterior: mesAnterior, mesActual: mesActual, ventaAnterior: ventaAnterior, ventaActual: ventaActual, promedio: promedioHistorico, caida: caidaMes, tipo: 'Caída fuerte', severity: 'media' });
            }
        }
    });

    lost.sort(function(x, y) { return y.caida - x.caida; });
    return { lost: lost, mesActual: mesActual, mesAnterior: mesAnterior };
}

// ============================================================
// GRÁFICAS
// ============================================================
function renderCharts(a, fuelData) {
    // 1. Distribución Fuel Oil
    var byProducto = groupBy(fuelData, 'producto').map(function(item) {
        return { producto: item[0] || 'Fuel Oil', volumen: sum(item[1], 'volumen') };
    }).sort(function(x, y) { return y.volumen - x.volumen; });
    var topProducts = byProducto.slice(0, 6);

    var ctx1 = document.getElementById('fuelChart');
    if (ctx1) {
        if (fuelChartInstance) fuelChartInstance.destroy();
        var colorsFuel = ['#ffb74d', '#ff5fd2', '#ffd54f', '#ff8a65', '#e879f9', '#4df0ff'];
        fuelChartInstance = new Chart(ctx1, {
            type: 'doughnut',
            data: {
                labels: topProducts.map(function(p) { return p.producto; }),
                datasets: [{
                    data: topProducts.map(function(p) { return p.volumen; }),
                    backgroundColor: colorsFuel.slice(0, topProducts.length),
                    borderColor: 'rgba(4,18,30,0.9)',
                    borderWidth: 2,
                    hoverOffset: 12
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false, cutout: '68%',
                plugins: {
                    legend: { position: 'right', labels: { color: '#edf9ff', font: { size: 9, family: 'Inter' }, padding: 10, usePointStyle: true, pointStyleWidth: 8 } },
                    tooltip: {
                        backgroundColor: 'rgba(4,18,30,0.96)', titleColor: '#edf9ff', bodyColor: '#8bb8d0',
                        borderColor: 'rgba(255,183,77,0.3)', borderWidth: 1, cornerRadius: 12, padding: 12,
                        callbacks: {
                            label: function(context) {
                                var total = context.dataset.data.reduce(function(a, b) { return a + b; }, 0);
                                var pct = total > 0 ? ((context.parsed / total) * 100).toFixed(1) : 0;
                                return context.label + ': ' + N.format(context.parsed) + ' gal (' + pct + '%)';
                            }
                        }
                    }
                },
                animation: { animateRotate: true, duration: 1400 }
            }
        });
    }

    // 2. Rendimiento General
    var ctx2 = document.getElementById('generalChart');
    if (ctx2) {
        if (generalChartInstance) generalChartInstance.destroy();
        var monthlyData = {};
        a.forEach(function(o) {
            var mes = t(o.mes) || 'Sin mes';
            if (!monthlyData[mes]) monthlyData[mes] = { sales: 0, margin: 0 };
            monthlyData[mes].sales += n(o.subtotalVenta);
            monthlyData[mes].margin += n(o.margenBruto);
        });
        var mesesOrdenados = MESES_ORDER.filter(function(m) { return monthlyData[m] !== undefined; });
        var salesData = mesesOrdenados.map(function(m) { return monthlyData[m].sales; });
        var marginData = mesesOrdenados.map(function(m) { return monthlyData[m].margin; });

        var grad = ctx2.getContext('2d').createLinearGradient(0, 0, 0, 200);
        grad.addColorStop(0, 'rgba(15,240,212,0.75)');
        grad.addColorStop(0.5, 'rgba(15,240,212,0.3)');
        grad.addColorStop(1, 'rgba(15,240,212,0.03)');

        generalChartInstance = new Chart(ctx2, {
            type: 'bar',
            data: {
                labels: mesesOrdenados,
                datasets: [
                    { label: 'Ventas', data: salesData, backgroundColor: grad, borderColor: '#0ff0d4', borderWidth: 1.5, borderRadius: 6, barPercentage: 0.5, yAxisID: 'y' },
                    { label: 'Margen', data: marginData, type: 'line', borderColor: '#ff5fd2', backgroundColor: 'rgba(255,95,210,0.08)', borderWidth: 2.5, fill: true, tension: 0.35, pointBackgroundColor: '#ff5fd2', pointBorderColor: '#04121e', pointBorderWidth: 2, pointRadius: 4, pointHoverRadius: 7, yAxisID: 'y1', order: 1 }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'top', labels: { color: '#edf9ff', font: { size: 9, family: 'Inter' }, padding: 10, usePointStyle: true, pointStyleWidth: 8 } },
                    tooltip: {
                        backgroundColor: 'rgba(4,18,30,0.96)', titleColor: '#edf9ff', bodyColor: '#8bb8d0',
                        borderColor: 'rgba(15,240,212,0.3)', borderWidth: 1, cornerRadius: 12, padding: 12,
                        callbacks: { label: function(context) { return context.dataset.label + ': ' + M.format(context.parsed.y); } }
                    }
                },
                scales: {
                    x: { grid: { color: 'rgba(15,240,212,0.06)', drawTicks: false }, ticks: { color: '#8bb8d0', font: { size: 8, family: 'Inter' }, maxRotation: 25, minRotation: 10 } },
                    y: { position: 'left', grid: { color: 'rgba(15,240,212,0.04)', drawTicks: false }, ticks: { color: '#8bb8d0', font: { size: 8, family: 'Inter' }, callback: function(v) { return M.format(v); } }, beginAtZero: true },
                    y1: { position: 'right', grid: { display: false }, ticks: { color: '#ff5fd2', font: { size: 7, family: 'Inter' }, callback: function(v) { return M.format(v); } }, beginAtZero: true }
                },
                interaction: { intersect: false, mode: 'index' },
                animation: { duration: 1200 }
            }
        });
    }

    // 3. Top Clientes
    var ctx3 = document.getElementById('clientChart');
    if (ctx3) {
        if (clientChartInstance) clientChartInstance.destroy();
        var byCliente = groupBy(a, 'cliente').map(function(item) {
            return { cliente: item[0] || 'Sin registrar', ventas: sum(item[1], 'subtotalVenta'), margen: sum(item[1], 'margenBruto'), viajes: item[1].length, volumen: sum(item[1], 'despachado') };
        }).sort(function(x, y) { return y.ventas - x.ventas; }).slice(0, 8);
        var clientNames = byCliente.map(function(c) { return c.cliente.length > 18 ? c.cliente.substring(0, 16) + '…' : c.cliente; });
        var clientSales = byCliente.map(function(c) { return c.ventas; });
        var clientMargins = byCliente.map(function(c) { return c.margen; });

        clientChartInstance = new Chart(ctx3, {
            type: 'bar',
            data: {
                labels: clientNames,
                datasets: [
                    { label: 'Ventas', data: clientSales, backgroundColor: 'rgba(15,240,212,0.65)', borderColor: '#0ff0d4', borderWidth: 1.5, borderRadius: 6, barPercentage: 0.6 },
                    { label: 'Margen', data: clientMargins, backgroundColor: 'rgba(255,183,77,0.65)', borderColor: '#ffb74d', borderWidth: 1.5, borderRadius: 6, barPercentage: 0.6 }
                ]
            },
            options: {
                indexAxis: 'y', responsive: true, maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'top', labels: { color: '#edf9ff', font: { size: 9, family: 'Inter' }, padding: 10, usePointStyle: true, pointStyleWidth: 8 } },
                    tooltip: {
                        backgroundColor: 'rgba(4,18,30,0.96)', titleColor: '#edf9ff', bodyColor: '#8bb8d0',
                        borderColor: 'rgba(15,240,212,0.3)', borderWidth: 1, cornerRadius: 12, padding: 12,
                        callbacks: {
                            label: function(context) { return context.dataset.label + ': ' + M.format(context.parsed.x); },
                            afterBody: function(items) {
                                var c = byCliente[items[0].dataIndex];
                                return ['Viajes: ' + c.viajes, 'Volumen: ' + N.format(c.volumen) + ' gal'];
                            }
                        }
                    }
                },
                scales: {
                    x: { grid: { color: 'rgba(15,240,212,0.06)', drawTicks: false }, ticks: { color: '#8bb8d0', font: { size: 8, family: 'Inter' }, callback: function(v) { return M.format(v); } }, beginAtZero: true },
                    y: { grid: { display: false }, ticks: { color: '#8bb8d0', font: { size: 8, family: 'Inter' } } }
                },
                animation: { duration: 1200 }
            }
        });
    }

    // 4. Comparación Mes Actual vs Anterior
    var ctx4 = document.getElementById('compareChart');
    if (ctx4) {
        if (compareChartInstance) compareChartInstance.destroy();
        var monthData = {};
        a.forEach(function(o) {
            var mes = t(o.mes).toUpperCase();
            if (!mes || MESES_ORDER.indexOf(mes) === -1) return;
            if (!monthData[mes]) monthData[mes] = { sales: 0, margin: 0 };
            monthData[mes].sales += n(o.subtotalVenta);
            monthData[mes].margin += n(o.margenBruto);
        });
        var mesesPresentes = MESES_ORDER.filter(function(m) { return monthData[m] !== undefined; });

        if (mesesPresentes.length < 2) {
            compareChartInstance = new Chart(ctx4, {
                type: 'doughnut',
                data: { labels: ['Datos insuficientes'], datasets: [{ data: [1], backgroundColor: ['rgba(139,184,208,0.3)'], borderColor: 'rgba(4,18,30,0.9)', borderWidth: 2 }] },
                options: {
                    responsive: true, maintainAspectRatio: false, cutout: '72%',
                    plugins: {
                        legend: { display: true, position: 'bottom', labels: { color: '#8bb8d0', font: { size: 10, family: 'Inter' }, padding: 10, usePointStyle: true } },
                        tooltip: { enabled: false }
                    }
                }
            });
        } else {
            var mesActual = mesesPresentes[mesesPresentes.length - 1];
            var mesAnterior = mesesPresentes[mesesPresentes.length - 2];
            var dataActual = monthData[mesActual];
            var dataAnterior = monthData[mesAnterior];
            var varVentas = dataAnterior.sales > 0 ? ((dataActual.sales - dataAnterior.sales) / dataAnterior.sales) * 100 : 0;
            var varMargen = dataAnterior.margin > 0 ? ((dataActual.margin - dataAnterior.margin) / dataAnterior.margin) * 100 : 0;

            compareChartInstance = new Chart(ctx4, {
                type: 'bar',
                data: {
                    labels: ['Ventas', 'Margen'],
                    datasets: [
                        { label: mesAnterior, data: [dataAnterior.sales, dataAnterior.margin], backgroundColor: 'rgba(139,184,208,0.4)', borderColor: '#8bb8d0', borderWidth: 1.5, borderRadius: 6, barPercentage: 0.7 },
                        { label: mesActual, data: [dataActual.sales, dataActual.margin], backgroundColor: ['rgba(15,240,212,0.7)', 'rgba(255,183,77,0.7)'], borderColor: ['#0ff0d4', '#ffb74d'], borderWidth: 1.5, borderRadius: 6, barPercentage: 0.7 }
                    ]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: {
                        legend: { position: 'top', labels: { color: '#edf9ff', font: { size: 9, family: 'Inter' }, padding: 10, usePointStyle: true, pointStyleWidth: 8 } },
                        tooltip: {
                            backgroundColor: 'rgba(4,18,30,0.96)', titleColor: '#edf9ff', bodyColor: '#8bb8d0',
                            borderColor: 'rgba(15,240,212,0.3)', borderWidth: 1, cornerRadius: 12, padding: 12,
                            callbacks: {
                                label: function(context) { return context.dataset.label + ': ' + M.format(context.parsed.y); },
                                afterBody: function(items) {
                                    return items[0].dataIndex === 0 ? ['Variación: ' + varVentas.toFixed(1) + '%'] : ['Variación: ' + varMargen.toFixed(1) + '%'];
                                }
                            }
                        }
                    },
                    scales: {
                        x: { grid: { display: false }, ticks: { color: '#8bb8d0', font: { size: 11, family: 'Inter' } } },
                        y: { grid: { color: 'rgba(15,240,212,0.04)', drawTicks: false }, ticks: { color: '#8bb8d0', font: { size: 8, family: 'Inter' }, callback: function(v) { return M.format(v); } }, beginAtZero: true }
                    },
                    animation: { duration: 1200 }
                }
            });
            var sub = document.getElementById('carouselSubtitle');
            if (sub && carouselIndex === 3) sub.textContent = mesActual + ' vs ' + mesAnterior + ' · Ventas ' + (varVentas >= 0 ? '+' : '') + varVentas.toFixed(1) + '%';
        }
    }

    // 5. Clientes que dejaron de consumir
    var ctx5 = document.getElementById('lostChart');
    if (ctx5) {
        if (lostChartInstance) lostChartInstance.destroy();
        var result = detectLostClients(a);
        var lost = result.lost;

        if (lost.length === 0) {
            lostChartInstance = new Chart(ctx5, {
                type: 'doughnut',
                data: { labels: ['Sin clientes perdidos'], datasets: [{ data: [1], backgroundColor: ['rgba(90,255,160,0.5)'], borderColor: 'rgba(4,18,30,0.9)', borderWidth: 2 }] },
                options: {
                    responsive: true, maintainAspectRatio: false, cutout: '72%',
                    plugins: {
                        legend: { display: true, position: 'bottom', labels: { color: '#5affa0', font: { size: 10, family: 'Inter' }, padding: 10, usePointStyle: true } },
                        tooltip: {
                            backgroundColor: 'rgba(4,18,30,0.96)', titleColor: '#5affa0', bodyColor: '#8bb8d0',
                            borderColor: 'rgba(90,255,160,0.3)', borderWidth: 1, cornerRadius: 12, padding: 12,
                            callbacks: { label: function() { return '✅ Ningún cliente ha dejado de consumir'; } }
                        }
                    }
                }
            });
        } else {
            var topLost = lost.slice(0, 8);
            var names = topLost.map(function(l) { return l.cliente.length > 16 ? l.cliente.substring(0, 14) + '…' : l.cliente; });
            var caidas = topLost.map(function(l) { return l.caida; });
            var colorsLost = topLost.map(function(l) { return l.caida >= 100 ? 'rgba(255,84,112,0.75)' : l.caida >= 70 ? 'rgba(255,183,77,0.75)' : 'rgba(255,213,79,0.7)'; });

            lostChartInstance = new Chart(ctx5, {
                type: 'bar',
                data: {
                    labels: names,
                    datasets: [{ label: '% Caída', data: caidas, backgroundColor: colorsLost, borderColor: topLost.map(function(l) { return l.caida >= 100 ? '#ff5470' : l.caida >= 70 ? '#ffb74d' : '#ffd54f'; }), borderWidth: 1.5, borderRadius: 6, barPercentage: 0.6 }]
                },
                options: {
                    indexAxis: 'y', responsive: true, maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            backgroundColor: 'rgba(4,18,30,0.96)', titleColor: '#edf9ff', bodyColor: '#8bb8d0',
                            borderColor: 'rgba(255,84,112,0.3)', borderWidth: 1, cornerRadius: 12, padding: 12,
                            callbacks: {
                                label: function(context) { return 'Caída: ' + context.parsed.x.toFixed(1) + '%'; },
                                afterBody: function(items) {
                                    var l = topLost[items[0].dataIndex];
                                    return ['Tipo: ' + l.tipo, 'Mes anterior: ' + M.format(l.ventaAnterior), 'Mes actual: ' + M.format(l.ventaActual), 'Promedio: ' + M.format(l.promedio)];
                                }
                            }
                        }
                    },
                    scales: {
                        x: { grid: { color: 'rgba(15,240,212,0.04)', drawTicks: false }, ticks: { color: '#8bb8d0', font: { size: 8, family: 'Inter' }, callback: function(v) { return v.toFixed(0) + '%'; } }, beginAtZero: true, max: 110 },
                        y: { grid: { display: false }, ticks: { color: '#8bb8d0', font: { size: 8, family: 'Inter' } } }
                    },
                    animation: { duration: 1200 }
                }
            });
        }
    }

    // 6. Detector de Discrepancias
    var ctx6 = document.getElementById('discrepancyChart');
    if (ctx6) {
        if (discrepancyChartInstance) discrepancyChartInstance.destroy();
        var disc = detectDiscrepancies(a);

        if (disc.length === 0) {
            discrepancyChartInstance = new Chart(ctx6, {
                type: 'doughnut',
                data: { labels: ['Sin discrepancias'], datasets: [{ data: [1], backgroundColor: ['rgba(90,255,160,0.5)'], borderColor: 'rgba(4,18,30,0.9)', borderWidth: 2 }] },
                options: {
                    responsive: true, maintainAspectRatio: false, cutout: '72%',
                    plugins: {
                        legend: { display: true, position: 'bottom', labels: { color: '#5affa0', font: { size: 10, family: 'Inter' }, padding: 10, usePointStyle: true } },
                        tooltip: {
                            backgroundColor: 'rgba(4,18,30,0.96)', titleColor: '#5affa0', bodyColor: '#8bb8d0',
                            borderColor: 'rgba(90,255,160,0.3)', borderWidth: 1, cornerRadius: 12, padding: 12,
                            callbacks: { label: function() { return '✅ No se detectaron discrepancias'; } }
                        }
                    }
                }
            });
        } else {
            var byType = {};
            disc.forEach(function(d) { byType[d.tipo] = (byType[d.tipo] || 0) + 1; });
            var tipos = Object.keys(byType);
            var counts = tipos.map(function(tp) { return byType[tp]; });
            var colorsDisc = ['#ff5470', '#ffb74d', '#ffd54f', '#e879f9', '#b56eff'];

            discrepancyChartInstance = new Chart(ctx6, {
                type: 'bar',
                data: { labels: tipos, datasets: [{ label: 'Casos detectados', data: counts, backgroundColor: colorsDisc.slice(0, tipos.length), borderColor: 'rgba(4,18,30,0.9)', borderWidth: 1.5, borderRadius: 6, barPercentage: 0.6 }] },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            backgroundColor: 'rgba(4,18,30,0.96)', titleColor: '#edf9ff', bodyColor: '#8bb8d0',
                            borderColor: 'rgba(255,84,112,0.3)', borderWidth: 1, cornerRadius: 12, padding: 12,
                            callbacks: {
                                label: function(context) { return context.parsed.y + ' caso(s)'; },
                                afterBody: function(items) {
                                    var tipo = tipos[items[0].dataIndex];
                                    var casos = disc.filter(function(d) { return d.tipo === tipo; });
                                    var lines = [];
                                    casos.slice(0, 3).forEach(function(c) { lines.push('• ' + c.cliente + ': ' + c.detalle); });
                                    if (casos.length > 3) lines.push('  ... +' + (casos.length - 3) + ' más');
                                    return lines;
                                }
                            }
                        }
                    },
                    scales: {
                        x: { grid: { display: false }, ticks: { color: '#8bb8d0', font: { size: 8, family: 'Inter' }, maxRotation: 25 } },
                        y: { grid: { color: 'rgba(15,240,212,0.04)', drawTicks: false }, ticks: { color: '#8bb8d0', font: { size: 8, family: 'Inter' }, precision: 0 }, beginAtZero: true }
                    },
                    animation: { duration: 1200 }
                }
            });
        }
    }
}

// ============================================================
// RENDER PANELES
// ============================================================
function renderUnifiedPanel(a, fuelData) {
    var sourceBadge = getSourceBadgeHTML();
    var fuelSourceBadge = getFuelSourceBadgeHTML();
    var z = a.reduce(function(s, o) { return { rq: s.rq + n(o.solicitado), ds: s.ds + n(o.despachado), sales: s.sales + n(o.subtotalVenta), margin: s.margin + n(o.margenBruto) }; }, { rq: 0, ds: 0, sales: 0, margin: 0 });
    var comp = z.rq ? z.ds / z.rq : 0;
    var pending = a.filter(function(o) { return n(o.solicitado) > n(o.despachado); }).length;

    var byProducto = [];
    if (fuelData && fuelData.length > 0) {
        byProducto = groupBy(fuelData, 'producto').map(function(item) {
            return { producto: item[0] || 'Fuel Oil', volumen: sum(item[1], 'volumen'), venta: sum(item[1], 'subTotalVenta') };
        }).sort(function(x, y) { return y.volumen - x.volumen; });
    }
    var topCombustibles = groupBy(a, 'combustible').map(function(item) {
        return { producto: item[0] || 'Sin clasificar', despachado: sum(item[1], 'despachado') };
    }).sort(function(x, y) { return y.despachado - x.despachado; }).slice(0, 4);

    var fulfillEl = document.getElementById('fulfill');
    if (fulfillEl) {
        var fuelHtml = '';
        if (byProducto.length > 0) {
            fuelHtml = byProducto.slice(0, 5).map(function(x) {
                return '<div class="product-item fuel-item"><div class="p-name">🛢️ ' + esc(x.producto) + '</div><div class="p-value"><b>' + N.format(x.volumen) + '</b> gal · ' + M.format(x.venta) + '</div></div>';
            }).join('');
        } else {
            fuelHtml = '<div style="color:var(--txt-muted);font-size:10px;padding:4px 0;">No hay productos Fuel Oil registrados</div>';
        }
        var combustibleHtml = topCombustibles.map(function(x) {
            return '<div class="product-item"><div class="p-name">⛽ ' + esc(x.producto) + '</div><div class="p-value"><b>' + N.format(x.despachado) + '</b> gal despachados</div></div>';
        }).join('');

        fulfillEl.innerHTML =
            '<div class="title"><div><h2>📊 Cumplimiento · Productos</h2><small>Fuel Oil · Combustible</small></div><div>' + fuelSourceBadge + ' ' + sourceBadge + '</div></div>' +
            '<div class="fulfill-body" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">' +
            '<div><div class="section-title" style="color:var(--neon-amber);border-bottom-color:rgba(255,183,77,0.15);">🛢️ Fuel Oil</div><div class="product-grid">' + fuelHtml + '</div></div>' +
            '<div><div style="background:rgba(255,255,255,0.02);border-radius:var(--radius-sm);padding:12px;border:1px solid rgba(255,255,255,0.03);">' +
            '<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--txt-muted);margin-bottom:5px;letter-spacing:0.3px;"><span>Cumplimiento</span><span style="color:var(--neon-teal);font-weight:600;">' + (comp * 100).toFixed(1) + '%</span></div>' +
            '<div class="progress" style="height:7px;background:#0a1f2e;border-radius:6px;overflow:hidden;box-shadow:inset 0 1px 4px rgba(0,0,0,0.4);"><i style="display:block;height:100%;width:' + Math.min(comp * 100, 100) + '%;background:linear-gradient(90deg, #5affa0, #0ff0d4);border-radius:6px;transition:width 0.9s var(--transition-smooth);box-shadow:0 0 12px rgba(15,240,212,0.4);"></i></div>' +
            '<div class="stats-row" style="margin-top:10px;">' +
            '<div class="stat-item"><b>' + N.format(z.ds) + '</b><span>Despachado</span></div>' +
            '<div class="stat-item"><b>' + N.format(Math.max(z.rq - z.ds, 0)) + '</b><span>Pendiente</span></div>' +
            '<div class="stat-item"><b>' + pending + '</b><span>Parciales</span></div>' +
            '</div>' +
            '<div style="margin-top:8px;border-top:1px solid rgba(15,240,212,0.06);padding-top:8px;">' +
            '<div class="section-title">⛽ Combustible</div><div class="product-grid">' + combustibleHtml + '</div></div></div></div></div>';
    }

    // ALERTAS
    var allAlertItems = [];
    var incompleteOps = a.filter(function(o) { return n(o.solicitado) > n(o.despachado); });
    var noInvoiceOps = a.filter(function(o) { return !t(o.facturaGSN); });
    var negMarginOps = a.filter(function(o) { return n(o.margenBruto) < 0; });
    var noDriverOps = a.filter(function(o) { return !t(o.conductor); });
    var discOps = detectDiscrepancies(a);
    var lostResult = detectLostClients(a);
    var lostClients = lostResult.lost;

    if (incompleteOps.length > 0) {
        allAlertItems.push({
            label: '⚠️ Despachos incompletos', value: incompleteOps.length,
            detail: 'Operaciones con despacho menor a lo solicitado',
            locations: incompleteOps.map(function(o) { var loc = getLocation(o._rowIndex || 0, 'despachado'); return { row: loc.row, col: loc.col, description: 'Solicitado: ' + N.format(n(o.solicitado)) + ' | Despachado: ' + N.format(n(o.despachado)) + ' | Cliente: ' + t(o.cliente) }; }),
            formula: 'Pendiente = Suma(Solicitado - Despachado)',
            explanation: 'Estas operaciones tienen un saldo pendiente de despachar.',
            solution: 'Contactar a los clientes para coordinar los despachos pendientes.', isFuel: false
        });
    }
    if (noInvoiceOps.length > 0) {
        allAlertItems.push({
            label: '📄 Sin factura GSN', value: noInvoiceOps.length,
            detail: 'Operaciones sin factura GSN registrada',
            locations: noInvoiceOps.map(function(o) { var loc = getLocation(o._rowIndex || 0, 'facturaGSN'); return { row: loc.row, col: loc.col, description: 'Cliente: ' + t(o.cliente) + ' | Pedido: ' + t(o.pedidoPuma) }; }),
            solution: 'Registrar el número de factura GSN en la columna correspondiente.', isFuel: false
        });
    }
    if (negMarginOps.length > 0) {
        allAlertItems.push({
            label: '💰 Margen negativo', value: negMarginOps.length,
            detail: 'Operaciones con margen bruto negativo',
            locations: negMarginOps.map(function(o) { var loc = getLocation(o._rowIndex || 0, 'margenBruto'); return { row: loc.row, col: loc.col, description: 'Margen: ' + M.format(n(o.margenBruto)) + ' | Cliente: ' + t(o.cliente) }; }),
            formula: 'Margen = Venta - Costos',
            explanation: 'El costo de estas operaciones supera al precio de venta.',
            solution: 'Revisar precios de venta y costos de estas operaciones.', isFuel: false
        });
    }
    if (noDriverOps.length > 0) {
        allAlertItems.push({
            label: '👤 Sin conductor', value: noDriverOps.length,
            detail: 'Operaciones sin conductor registrado',
            locations: noDriverOps.map(function(o) { var loc = getLocation(o._rowIndex || 0, 'conductor'); return { row: loc.row, col: loc.col, description: 'Cliente: ' + t(o.cliente) + ' | Placa: ' + t(o.placaEntrega || o.cisternaPickup || '') }; }),
            solution: 'Completar el nombre del conductor en la columna "NOMBRE CONDUCTOR".', isFuel: false
        });
    }
    if (lostClients.length > 0) {
        allAlertItems.push({
            label: '🚨 Clientes que dejaron de consumir', value: lostClients.length,
            detail: 'Clientes que compraban antes y ya no lo hacen o redujeron drásticamente',
            locations: lostClients.map(function(l) { return { row: 0, col: 'CLIENTE', description: l.cliente + ' · ' + l.tipo + ' · Caída ' + l.caida.toFixed(1) + '% (' + M.format(l.ventaAnterior) + ' → ' + M.format(l.ventaActual) + ')' }; }),
            formula: 'Detección: Cliente con venta > 0 en mes anterior y venta = 0 en mes actual, o caída > 50%',
            explanation: lostClients.length + ' cliente(s) dejaron de consumir o redujeron drásticamente su consumo.',
            solution: 'Contactar a estos clientes para conocer el motivo y recuperar la relación comercial.', isFuel: false
        });
    }
    if (discOps.length > 0) {
        allAlertItems.push({
            label: '🔍 Discrepancias en ventas', value: discOps.length,
            detail: 'Registros donde las ventas no coinciden con los cálculos esperados',
            locations: discOps.map(function(d) { return { row: d.row, col: 'AC/AE', description: '[' + d.tipo + '] ' + d.cliente + ' → ' + d.detalle }; }),
            formula: 'Validación: Margen ≤ Venta | Venta > 0 si hay despacho | Despacho ≤ Solicitado * 1.1',
            explanation: 'Se detectaron registros con inconsistencias entre venta, margen, volumen solicitado y despachado.',
            solution: 'Revisar cada registro marcado en la hoja de cálculo y corregir los valores inconsistentes.', isFuel: false
        });
    }
    if (fuelData && fuelData.length > 0) {
        var fuelNegMargen = fuelData.filter(function(o) { return n(o.margen) < 0; });
        if (fuelNegMargen.length > 0) {
            allAlertItems.push({
                label: '💰 Margen negativo (Fuel)', value: fuelNegMargen.length,
                detail: 'Operaciones Fuel Oil con margen negativo',
                locations: fuelNegMargen.map(function(o) { return { row: o._rowIndex || 0, col: 'MARGEN', description: 'Margen: ' + M.format(n(o.margen)) + ' | Producto: ' + t(o.producto) + ' | Conductor: ' + t(o.conductor) }; }),
                formula: 'Margen = Venta - Costo',
                explanation: 'El margen negativo indica que el costo supera al precio de venta.',
                solution: 'Revisar precios de compra (COSTO PUMA) y precios de venta.', isFuel: true
            });
        }
    }

    var alertsEl = document.getElementById('alerts');
    if (alertsEl) {
        var fuelCount = allAlertItems.filter(function(x) { return x.isFuel; }).length;
        var html = '<div class="title"><h2>⚠️ Panel de Alertas</h2><div>' + fuelSourceBadge + ' ' + sourceBadge + '</div></div><div class="alerts-scroll">';

        var fuelItems = allAlertItems.filter(function(x) { return x.isFuel; });
        if (fuelItems.length > 0) {
            html += '<div style="font-size:8px;color:var(--neon-amber);font-weight:700;text-transform:uppercase;letter-spacing:1.2px;margin:4px 0 5px 0;"><span class="footer-dot orange"></span> Fuel Oil (' + fuelCount + ')</div>';
            html += fuelItems.map(function(x) {
                return '<div class="alert fuel-alert" data-alert="' + esc(x.label) + '" data-value="' + x.value + '" data-locations="' + esc(encodeURIComponent(JSON.stringify(x.locations || []))) + '"><i>🛢️</i><div style="flex:1;"><b style="font-size:11px;">' + esc(x.label) + '</b><span class="source-tag fuel-tag">🛢️ Fuel</span><span style="font-size:8px;color:var(--txt-muted);display:block;">' + esc(x.detail) + '</span></div><span class="alert-badge fuel-badge">' + x.value + ' casos</span></div>';
            }).join('');
        }
        var generalItems = allAlertItems.filter(function(x) { return !x.isFuel; });
        if (fuelItems.length > 0 && generalItems.length > 0) {
            html += '<div class="alert-divider"><span class="divider-icon">⛽</span><span class="divider-text">Combustible</span><span class="divider-line"></span></div>';
        }
        if (generalItems.length > 0) {
            html += generalItems.map(function(x) {
                var iconMap = { '⚠️ Despachos incompletos': '📦', '📄 Sin factura GSN': '📄', '💰 Margen negativo': '💸', '👤 Sin conductor': '👤', '🔍 Discrepancias en ventas': '🔍', '🚨 Clientes que dejaron de consumir': '🚨' };
                var icon = iconMap[x.label] || '⚠️';
                return '<div class="alert" data-alert="' + esc(x.label) + '" data-value="' + x.value + '" data-locations="' + esc(encodeURIComponent(JSON.stringify(x.locations || []))) + '"><i>' + icon + '</i><div style="flex:1;"><b style="font-size:11px;">' + esc(x.label) + '</b><span class="source-tag general-tag">📊 General</span><span style="font-size:8px;color:var(--txt-muted);display:block;">' + esc(x.detail) + '</span></div><span class="alert-badge">' + x.value + ' casos</span></div>';
            }).join('');
        }
        if (allAlertItems.length === 0) {
            html += '<div style="padding:24px;text-align:center;color:var(--neon-green);">✅ Sin alertas para el período seleccionado</div>';
        }
        html += '</div><div class="alerts-footer"><span class="footer-dot orange"></span> Fuel Oil<span class="footer-sep">·</span><span class="footer-dot teal"></span> Combustible<span class="footer-sep">·</span>Haz clic en una alerta para ver detalles</div>';
        alertsEl.innerHTML = html;
    }

    document.querySelectorAll('#alerts .alert').forEach(function(el) {
        el.onclick = function() {
            var label = this.dataset.alert;
            var value = parseInt(this.dataset.value) || 0;
            var locations = [];
            try { locations = JSON.parse(decodeURIComponent(this.dataset.locations || '%5B%5D')); } catch (e) { locations = []; }
            var alertData = allAlertItems.find(function(x) { return x.label === label; });
            showInfoTooltip('Alerta: ' + label, value + ' casos identificados',
                'Hay <span class="highlight">' + value + '</span> operaciones con ' + esc(label.toLowerCase()) + '.',
                { locations: locations.slice(0, 15), error: (alertData && alertData.detail) || 'Informacion pendiente',
                  solution: (alertData && alertData.solution) || 'Revisar los datos en la hoja de calculo.', fields: (alertData && alertData.fields) || [] });
        };
    });
}

// ============================================================
// RENDER RESUMEN
// ============================================================
function renderSummary() {
    isFuelView = false;
    var vt = document.getElementById('viewTitle');
    var vs = document.getElementById('viewSubtitle');
    if (vt) vt.textContent = 'Resumen Ejecutivo';
    if (vs) vs.textContent = 'Dashboard gerencial · Grupo GSN';

    var a = filtered().sort(function(x, y) { return String(y.fecha ?? '').localeCompare(String(x.fecha ?? '')); });
    var fuelData = filteredFuel();

    var totalVolumen = fuelData.reduce(function(s, o) { return s + (n(o.volumen) || 0); }, 0);
    var totalVenta = fuelData.reduce(function(s, o) { return s + (n(o.subTotalVenta) || 0); }, 0);
    var totalMargen = fuelData.reduce(function(s, o) { return s + (n(o.margen) || 0); }, 0);
    var margenPct = totalVenta ? (totalMargen / totalVenta * 100) : 0;
    var totalViajes = fuelData.length;

    var fuelKpis = [
        { label: 'Volumen Total', value: N.format(totalVolumen) + ' gal', pct: null, icon: '🛢️' },
        { label: 'Venta Total', value: M.format(totalVenta), pct: null, icon: '💰' },
        { label: 'Margen Fuel', value: M.format(totalMargen), pct: margenPct.toFixed(2) + '%', icon: '📈' },
        { label: 'Viajes', value: N.format(totalViajes), pct: null, icon: '📋' }
    ];

    var z = a.reduce(function(s, o) { return { rq: s.rq + n(o.solicitado), ds: s.ds + n(o.despachado), sales: s.sales + n(o.subtotalVenta), margin: s.margin + n(o.margenBruto) }; }, { rq: 0, ds: 0, sales: 0, margin: 0 });
    var margenGeneralPct = z.sales ? (z.margin / z.sales * 100) : 0;
    var cumplimientoPct = z.rq ? (z.ds / z.rq * 100) : 0;

    var generalKpis = [
        { label: 'Volumen solicitado', value: N.format(z.rq) + ' gal', pct: null, icon: '📦' },
        { label: 'Volumen despachado', value: N.format(z.ds) + ' gal', pct: cumplimientoPct.toFixed(1) + '%', icon: '✅' },
        { label: 'Ventas General', value: M.format(z.sales), pct: null, icon: '💰' },
        { label: 'Margen bruto General', value: M.format(z.margin), pct: margenGeneralPct.toFixed(2) + '%', icon: '📈' }
    ];

    var fuelGrid = document.getElementById('fuelKpisGrid');
    var generalGrid = document.getElementById('generalKpisGrid');

    if (fuelGrid) {
        fuelGrid.innerHTML = fuelKpis.map(function(k) {
            var pctHtml = k.pct ? '<span class="value-pct">' + k.pct + '</span>' : '';
            return '<div class="kpi-item fuel-item" onclick="showKPIInfo(\'' + esc(k.label) + '\', \'' + esc(k.value) + '\', \'' + esc(k.pct || '') + '\')"><span class="kpi-icon">' + k.icon + '</span><div class="kpi-value"><span class="value-main">' + esc(k.value) + '</span>' + pctHtml + '</div><span class="kpi-label">' + esc(k.label) + '</span></div>';
        }).join('');
    }
    if (generalGrid) {
        generalGrid.innerHTML = generalKpis.map(function(k) {
            var pctHtml = k.pct ? '<span class="value-pct">' + k.pct + '</span>' : '';
            return '<div class="kpi-item" onclick="showKPIInfo(\'' + esc(k.label) + '\', \'' + esc(k.value) + '\', \'' + esc(k.pct || '') + '\')"><span class="kpi-icon">' + k.icon + '</span><div class="kpi-value"><span class="value-main">' + esc(k.value) + '</span>' + pctHtml + '</div><span class="kpi-label">' + esc(k.label) + '</span></div>';
        }).join('');
    }

    renderCharts(a, fuelData);
    renderUnifiedPanel(a, fuelData);
}

// ============================================================
// RENDER PRINCIPAL
// ============================================================
function render() {
    if (isRendering) { pendingUpdate = true; return; }
    isRendering = true;
    try {
        renderSummary();
    } catch (error) {
        console.error('Error de vista', activeView, error);
        var viewTitle = document.getElementById('viewTitle');
        if (viewTitle) viewTitle.textContent = 'No se pudo cargar esta vista';
        var viewSubtitle = document.getElementById('viewSubtitle');
        if (viewSubtitle) viewSubtitle.textContent = 'Puede cambiar a otro menu o volver a intentarlo';
    }
    isRendering = false;
    if (pendingUpdate) { pendingUpdate = false; render(); }
}

// ============================================================
// FILTROS EVENTOS
// ============================================================
['period', 'client', 'fuel', 'fleet'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) {
        el.onchange = function(e) {
            state[e.target.id] = e.target.value;
            state.page = 1;
            render();
        };
    }
});

// ============================================================
// PARSER DE APPS SCRIPT
// ============================================================
function rowsToObjects(payload) {
    if (!payload || typeof payload !== 'object') return [];
    if (payload.ok === false) return [];
    if (payload.rows && Array.isArray(payload.rows) && payload.rows.length > 0) {
        if (typeof payload.rows[0] === 'object' && !Array.isArray(payload.rows[0])) return payload.rows;
    }
    if (!payload.headers || !Array.isArray(payload.headers)) return [];
    if (!payload.rows || !Array.isArray(payload.rows)) return [];

    const COLUMN_MAP = {
        'FECHA DE ENTREGA CTE': 'fecha', 'FECHA DE ENTREGA': 'fecha', 'FECHA': 'fecha',
        'MES': 'mes', 'SUB CLIENTE': 'cliente', 'TIPO DE COMBUSTIBLE': 'combustible',
        'SUB CLIENTE2': 'destino', 'TIPO DE ENTREGA': 'tipoEntrega',
        'VOLUMEN GLNS SOLICITADO': 'solicitado', 'VOLUMEN GLNS DESPACHADO': 'despachado',
        'NO PEDIDO PUMA': 'pedidoPuma', 'NO FACTURA PUMA': 'facturaPuma',
        'RUBRO CLIENTE': 'rubro', 'COSTO UNITARIO DE COMPRA': 'costoUnitario',
        'COSTO DIRECTO - COMPRA COMBUSTIBLE': 'costoDirecto',
        'CODIGO DE CARGA PUMA': 'codigoCarga', 'NO PLACA CISTERNA PICK UP': 'cisternaPickup',
        'FLOTA': 'flota', 'PLACA ENTREGA': 'placaEntrega', 'DIESEL CISTERNA': 'dieselCisterna',
        'NOMBRE CONDUCTOR': 'conductor', 'NO REMISION': 'remision',
        'COMISION CONDUCTOR': 'comision', 'AYUDANTE': 'ayudante', 'VIATICOS': 'viaticos',
        'CAMBIO DE LLANTAS': 'llantas', 'EFECTIVO PARA DIESEL DE RETORNO': 'dieselRetorno',
        'IMPREVISTOS': 'imprevistos', 'COSTOS TOTALES': 'costosTotales',
        'PRECIO DE VENTA': 'precioVenta', 'SUB TOTAL VENTA': 'subtotalVenta',
        'NO FACTURA GSN': 'facturaGSN', 'MARGEN BRUTO': 'margenBruto',
        '% MB': 'margenPct', 'SOBRANTE GALONES': 'sobrante', 'OBSERVACIONES': 'observaciones'
    };

    const columnIndexMap = {};
    for (let i = 0; i < payload.headers.length; i++) {
        const headerName = String(payload.headers[i]).toUpperCase().trim();
        for (const colName in COLUMN_MAP) {
            if (headerName === colName.toUpperCase()) { columnIndexMap[i] = COLUMN_MAP[colName]; break; }
        }
    }

    const result = [];
    for (let idx = 0; idx < payload.rows.length; idx++) {
        const row = payload.rows[idx];
        if (typeof row === 'object' && !Array.isArray(row)) { result.push(row); continue; }
        if (!Array.isArray(row)) continue;

        const obj = {};
        let hasFecha = false;

        for (const colIdx in columnIndexMap) {
            const fieldName = columnIndexMap[colIdx];
            const i = parseInt(colIdx);
            if (i >= row.length) continue;
            let val = row[i];

            if (val === '' || val === null || val === undefined) { obj[fieldName] = null; }
            else if (typeof val === 'number') { obj[fieldName] = val; }
            else if (val instanceof Date) {
                const year = val.getFullYear();
                if (year >= 1900 && year <= 2100) {
                    obj[fieldName] = val.toISOString().replace('T', ' ').slice(0, 19);
                    if (fieldName === 'fecha') hasFecha = true;
                } else { obj[fieldName] = null; }
            } else if (typeof val === 'string') {
                const trimmed = val.trim();
                if (fieldName === 'fecha') {
                    const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
                    if (match) {
                        const year = parseInt(match[1]);
                        if (year >= 1900 && year <= 2100) { obj[fieldName] = trimmed; hasFecha = true; continue; }
                    }
                    const d = new Date(trimmed);
                    if (!isNaN(d.getTime())) {
                        const year = d.getFullYear();
                        if (year >= 1900 && year <= 2100) { obj[fieldName] = trimmed; hasFecha = true; continue; }
                    }
                    obj[fieldName] = null;
                } else if (trimmed !== '' && !isNaN(trimmed) && trimmed.match(/^[\d,.\-]+$/)) {
                    obj[fieldName] = parseFloat(trimmed.replace(/,/g, ''));
                } else { obj[fieldName] = trimmed; }
            } else if (typeof val === 'boolean') { obj[fieldName] = val; }
            else { obj[fieldName] = String(val).trim(); }
        }

        if (!hasFecha && obj.fecha) hasFecha = true;
        if (hasFecha || obj.cliente || obj.pedidoPuma) { obj.id = result.length + 1; obj._rowIndex = idx + 2; result.push(obj); }
    }
    return result;
}

function rowsToObjectsFuel(payload) {
    if (!payload || typeof payload !== 'object') return [];
    if (payload.ok === false) return [];
    if (payload.rows && Array.isArray(payload.rows) && payload.rows.length > 0) {
        if (typeof payload.rows[0] === 'object' && !Array.isArray(payload.rows[0])) return payload.rows;
    }
    if (!payload.headers || !Array.isArray(payload.headers)) return [];
    if (!payload.rows || !Array.isArray(payload.rows)) return [];

    const COLUMN_MAP_FUEL = {
        'FECHA': 'fecha', 'MES': 'mes', 'CONDUCTOR': 'conductor',
        'PLACA CISTERNA': 'placaCisterna', 'PRODUCTO': 'producto',
        'VOLUMEN': 'volumen', 'COSTO PUMA': 'costoPuma',
        'SUB TOTAL COSTO': 'subTotalCosto', 'SUB TOTAL VENTA': 'subTotalVenta',
        'MARGEN': 'margen', 'NO. DE CARGA': 'noCarga', 'PEDIDO': 'pedido', 'FACTURA': 'factura'
    };

    const columnIndexMap = {};
    for (let i = 0; i < payload.headers.length; i++) {
        const headerName = String(payload.headers[i]).toUpperCase().trim();
        for (const colName in COLUMN_MAP_FUEL) {
            if (headerName === colName.toUpperCase() || headerName.includes(colName.toUpperCase())) {
                columnIndexMap[i] = COLUMN_MAP_FUEL[colName]; break;
            }
        }
    }

    const result = [];
    for (let idx = 0; idx < payload.rows.length; idx++) {
        const row = payload.rows[idx];
        if (typeof row === 'object' && !Array.isArray(row)) { result.push(row); continue; }
        if (!Array.isArray(row)) continue;

        let hasData = false;
        for (let k = 0; k < Math.min(row.length, 5); k++) {
            if (row[k] !== '' && row[k] !== null && row[k] !== undefined) { hasData = true; break; }
        }
        if (!hasData) continue;

        const obj = {};
        let hasFecha = false;

        for (const colIdx in columnIndexMap) {
            const fieldName = columnIndexMap[colIdx];
            const i = parseInt(colIdx);
            if (i >= row.length) continue;
            let val = row[i];

            if (val === '' || val === null || val === undefined) { obj[fieldName] = null; }
            else if (typeof val === 'number') {
                obj[fieldName] = val;
                if (fieldName === 'fecha' && val > 0) {
                    const date = new Date((val - 25569) * 86400 * 1000);
                    if (!isNaN(date.getTime())) {
                        const year = date.getFullYear();
                        if (year >= 1900 && year <= 2100) { obj[fieldName] = date.toISOString().split('T')[0]; hasFecha = true; }
                    }
                }
            } else if (val instanceof Date) {
                const year = val.getFullYear();
                if (year >= 1900 && year <= 2100) { obj[fieldName] = val.toISOString().split('T')[0]; if (fieldName === 'fecha') hasFecha = true; }
                else { obj[fieldName] = null; }
            } else if (typeof val === 'string') {
                const trimmed = val.trim();
                if (fieldName === 'fecha') {
                    const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
                    if (match) { const year = parseInt(match[1]); if (year >= 1900 && year <= 2100) { obj[fieldName] = trimmed; hasFecha = true; continue; } }
                    const d = new Date(trimmed);
                    if (!isNaN(d.getTime())) {
                        const year = d.getFullYear();
                        if (year >= 1900 && year <= 2100) { obj[fieldName] = d.toISOString().split('T')[0]; hasFecha = true; continue; }
                    }
                    obj[fieldName] = null;
                } else if (trimmed !== '' && !isNaN(trimmed) && trimmed.match(/^[\d,.\-]+$/)) {
                    obj[fieldName] = parseFloat(trimmed.replace(/,/g, ''));
                } else { obj[fieldName] = trimmed; }
            } else if (typeof val === 'boolean') { obj[fieldName] = val; }
            else { obj[fieldName] = String(val).trim(); }
        }

        if (hasFecha || obj.conductor || obj.placaCisterna || obj.producto) { obj.id = result.length + 1; obj._rowIndex = idx + 2; result.push(obj); }
    }
    return result;
}

// ============================================================
// CARGA AUTÓNOMA DESDE APPS SCRIPT
// ============================================================
async function fetchMayoreo() {
    const url = SCRIPT_URL + '?key=' + encodeURIComponent(CLAVE_CARPETA) + '&t=' + Date.now();
    const resp = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' } });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    if (!data || data.ok === false) throw new Error((data && data.error) || 'Respuesta inválida');
    return { rows: rowsToObjects(data), updatedAt: data.updatedAt };
}

async function fetchFuel() {
    const url = SCRIPT_URL_FUEL + '&key=' + encodeURIComponent(CLAVE_CARPETA) + '&t=' + Date.now();
    const resp = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' } });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    if (!data || data.ok === false) throw new Error((data && data.error) || 'Respuesta inválida');
    return { rows: rowsToObjectsFuel(data), updatedAt: data.updatedAt };
}

async function cargarDatos() {
    if (!isStandalone) return;
    console.log('📡 [Autónomo] Consultando Apps Script...');
    showToast('Actualizando datos...', 'loading');
    try {
        const [mayoreo, fuel] = await Promise.all([
            fetchMayoreo().catch(e => { console.error('Mayoreo:', e); return { rows: [], updatedAt: null }; }),
            fetchFuel().catch(e => { console.error('Fuel:', e); return { rows: [], updatedAt: null }; })
        ]);

        console.log('✅ [Autónomo] Mayoreo:', mayoreo.rows.length, '| Fuel Oil:', fuel.rows.length);

        DATA = mayoreo.rows;
        DATA_FUEL = fuel.rows;
        lastUpdateTime = mayoreo.updatedAt ? new Date(mayoreo.updatedAt) : new Date();
        lastUpdateFuelTime = fuel.updatedAt ? new Date(fuel.updatedAt) : new Date();

        refillFilters();
        render();
        hideToast();

        if (window.parent && window.parent.actualizarEstadoGlobal) {
            window.parent.actualizarEstadoGlobal(
                { time: lastUpdateTime.toLocaleTimeString('es-NI'), date: lastUpdateTime.toLocaleDateString('es-NI'), registros: DATA.length || '0' },
                { time: lastUpdateFuelTime.toLocaleTimeString('es-NI'), date: lastUpdateFuelTime.toLocaleDateString('es-NI'), registros: DATA_FUEL.length || '0' }
            );
        }
    } catch (err) {
        console.error('❌ [Autónomo] Error:', err);
        showToast('Error al cargar datos: ' + err.message, 'error', 4000);
    }
}

window.recargarDatosAutonomo = cargarDatos;

// ============================================================
// MENSAJES DEL PADRE (modo embebido)
// ============================================================
window.addEventListener('message', function(event) {
    var data = event.data;
    if (!data || !data.type) return;
    if (data.type === 'DATOS_ACTUALIZADOS') {
        console.log('📥 Recibiendo datos del Index...');
        DATA = data.data || [];
        DATA_FUEL = data.fuelData || [];
        lastUpdateTime = data.lastUpdate ? new Date(data.lastUpdate) : new Date();
        lastUpdateFuelTime = data.lastUpdateFuel ? new Date(data.lastUpdateFuel) : new Date();
        refillFilters();
        render();
        console.log('✅ Módulo actualizado');
    }
});

// ============================================================
// INICIALIZACIÓN
// ============================================================
function init() {
    window.showInfoTooltip = showInfoTooltip;
    window.hideInfoTooltip = hideInfoTooltip;
    window.render = render;
    window.showKPIInfo = showKPIInfo;
    window.showToast = showToast;
    window.hideToast = hideToast;
    window.goToSlide = goToSlide;

    initCarousel();

    if (isStandalone) {
        setTimeout(cargarDatos, 400);
        setInterval(cargarDatos, AUTO_REFRESH_MIN * 60 * 1000);
    } else {
        setTimeout(function() {
            if (window.parent && window.parent.postMessage) {
                window.parent.postMessage({ type: 'REQUEST_DATOS', view: 'summary' }, '*');
            }
        }, 500);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

console.log('✅ Resumen Ejecutivo AUTÓNOMO cargado · 6 gráficas · Estilo Futurista');