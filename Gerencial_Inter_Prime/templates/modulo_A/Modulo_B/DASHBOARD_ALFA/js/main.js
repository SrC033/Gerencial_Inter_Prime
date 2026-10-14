// ============================================================
// PANEL EJECUTIVO - EXECUTIVE COMMAND CENTER
// Layout: GIGETS (izq) | GRÁFICAS (centro) | NOTAS (der)
//
// 🔥 v9: Persistencia total + sin flash + 1 sola request
//        - Números completos con separador de miles (sin K/M)
//        - getAllCajas: 1 sola request en vez de 5
//        - Snapshot diff: solo re-renderiza si hay cambios reales
//        - Timeout 4s en fetch (no se cuelga)
//        - Mantiene datos previos si el fetch falla
// ============================================================

(function() {
    'use strict';

    // ⚠️ URL del Web App de Google Apps Script
    const API_BASE = 'https://script.google.com/macros/s/AKfycbzsU6bi2304lJRMQP_yKmI6AWDzmTmM04gYIMzzFd4-nzJhXlDTE81l0n6zfu4MDmk/exec';

    const MODULOS_CAJA = [
        { key: 'booking',     titulo: 'Bookings',     icono: 'fa-clipboard-list', color: 'module-booking',     desc: 'Órdenes de transporte y reservas' },
        { key: 'pagos',       titulo: 'Pagos',        icono: 'fa-coins',          color: 'module-pagos',       desc: 'Solicitudes y gestión de pagos' },
        { key: 'barcos',      titulo: 'Viajes',       icono: 'fa-ship',           color: 'module-barcos',      desc: 'Registro de viajes marítimos' },
        { key: 'combustible', titulo: 'Combustible',  icono: 'fa-gas-pump',       color: 'module-combustible', desc: 'Consumo y control de combustible' },
        { key: 'compras',     titulo: 'Compras',      icono: 'fa-shopping-cart',  color: 'module-compras',     desc: 'Órdenes de compra y suministros' }
    ];

    // Estado por módulo
    let cajaState = {};
    MODULOS_CAJA.forEach(m => {
        cajaState[m.key] = {
            data: null,
            comentarios: [],
            loaded: false,
            totalEnvios: 0
        };
    });

    let cajaChartInstances = {};
    let currentSlide = 0;
    let isDarkMode = false;
    let autoAdvanceTimer = null;
    let autoAdvancePaused = false;
    let primeraCargaHecha = false;
    let fetchEnCurso = false;

    const FETCH_TIMEOUT_MS = 4000;

    // ============================================================
    // TEMA
    // ============================================================
    function applyTheme(isDark) {
        isDarkMode = isDark;
        document.body.classList.toggle('dark-mode', isDark);
        renderAllCajaCharts();
    }

    // ============================================================
    // UTILIDADES
    // ============================================================
    // 🔥 Formato NUMÉRICO COMPLETO con separador de miles
    //    1981       → "1.981"
    //    513000     → "513.000"
    //    320438.55  → "320.438,55"
    //    0.5        → "0,5"
    //    null/NaN   → "0"
    function formatNumero(num) {
        if (num === null || num === undefined) return '0';
        const n = parseFloat(num);
        if (isNaN(n)) return '0';

        // ¿Es entero?
        if (Number.isInteger(n)) {
            // Separador de miles con punto (es-ES)
            return n.toLocaleString('es-ES');
        }

        // Tiene decimales → mostrar con coma decimal y punto de miles
        return n.toLocaleString('es-ES', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 2
        });
    }

    function getChartColors() {
        if (isDarkMode) {
            return {
                text: '#94a3b8',
                grid: 'rgba(96, 165, 250, 0.08)',
                border: 'rgba(96, 165, 250, 0.15)'
            };
        } else {
            return {
                text: '#64748b',
                grid: 'rgba(59, 130, 246, 0.06)',
                border: 'rgba(59, 130, 246, 0.1)'
            };
        }
    }

    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function formatearFechaComentario(fechaISO) {
        if (!fechaISO) return '';
        try {
            const d = new Date(fechaISO);
            if (isNaN(d.getTime())) return '';
            const ahora = new Date();
            const diffMs = ahora - d;
            const diffMin = Math.floor(diffMs / 60000);
            const diffHoras = Math.floor(diffMs / 3600000);
            const diffDias = Math.floor(diffMs / 86400000);
            if (diffMin < 1) return 'ahora';
            if (diffMin < 60) return `hace ${diffMin}m`;
            if (diffHoras < 24) return `hace ${diffHoras}h`;
            if (diffDias < 7) return `hace ${diffDias}d`;
            return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
        } catch (e) {
            return '';
        }
    }

    // ============================================================
    // FETCH GENÉRICO CON TIMEOUT
    // ============================================================
    async function fetchJSON(url, timeoutMs = FETCH_TIMEOUT_MS) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, {
                method: 'GET',
                redirect: 'follow',
                cache: 'no-store',
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }
            const text = await res.text();
            try {
                return JSON.parse(text);
            } catch (e) {
                console.warn('⚠️ Respuesta no-JSON:', text.slice(0, 200));
                throw new Error('Respuesta no es JSON válido');
            }
        } catch (err) {
            clearTimeout(timeoutId);
            if (err.name === 'AbortError') {
                throw new Error(`Timeout de ${timeoutMs}ms`);
            }
            throw err;
        }
    }

    // ============================================================
    // FETCH: CAJA DE UN MÓDULO (fallback si getAllCajas falla)
    // ============================================================
    async function fetchCajaModulo(moduleName) {
        const estadoPrevio = cajaState[moduleName];
        try {
            const url = `${API_BASE}?action=caja_ultimo&modulo=${encodeURIComponent(moduleName)}&t=${Date.now()}`;
            const result = await fetchJSON(url);

            const respuestaOk = (result.success === true) || (result.ok === true);

            if (respuestaOk) {
                cajaState[moduleName] = {
                    data: {
                        gigets:   result.gigets   || [],
                        graficas: result.graficas || []
                    },
                    comentarios: result.comentarios || [],
                    loaded: true,
                    totalEnvios: result.total_envios || 1
                };
                return true;
            }

            if (estadoPrevio && estadoPrevio.data) return true;
            cajaState[moduleName] = { data: null, comentarios: [], loaded: true, totalEnvios: 0 };
            return false;
        } catch (error) {
            console.error(`❌ [${moduleName}] ${error.message}`);
            if (estadoPrevio && estadoPrevio.data) return true;
            cajaState[moduleName] = { data: null, comentarios: [], loaded: true, totalEnvios: 0 };
            return false;
        }
    }

    // ============================================================
    // FETCH: TODAS LAS CAJAS EN 1 SOLA REQUEST
    // ------------------------------------------------------------
    // 🔥 Optimización v9: una sola llamada HTTP a getAllCajas
    //    devuelve los 5 módulos juntos. De ~1.5s a ~400ms.
    // ============================================================
    async function fetchAllCajas() {
        const t0 = performance.now();
        try {
            const url = `${API_BASE}?action=getAllCajas&t=${Date.now()}`;
            const result = await fetchJSON(url);

            const ok = (result.success === true) || (result.ok === true);

            if (ok && result.cajas) {
                MODULOS_CAJA.forEach(m => {
                    const caja = result.cajas[m.key] || { gigets: [], graficas: [] };
                    const comentarios = (result.comentarios && result.comentarios[m.key]) || [];
                    cajaState[m.key] = {
                        data: {
                            gigets:   caja.gigets   || [],
                            graficas: caja.graficas || []
                        },
                        comentarios: comentarios,
                        loaded: true,
                        totalEnvios: 1
                    };
                });
                const ms = (performance.now() - t0).toFixed(0);
                console.log(`📦 getAllCajas · ${MODULOS_CAJA.length} módulos · ${ms}ms`);
                return true;
            }

            console.warn('⚠️ getAllCajas ok=false · usando fallback por módulo');
        } catch (e) {
            console.warn('⚠️ getAllCajas exception:', e.message, '· usando fallback');
        }

        // Fallback: 5 requests en paralelo
        await Promise.all(MODULOS_CAJA.map(m => fetchCajaModulo(m.key)));
        return false;
    }

    // ============================================================
    // PLACEHOLDER ANIMADO
    // ============================================================
    function renderPlaceholder(icon, text) {
        return `
            <div class="caja-section-placeholder">
                <div class="placeholder-icon-wrap">
                    <i class="fas ${icon}"></i>
                </div>
                <div class="placeholder-text">
                    ${text}
                    <span class="placeholder-dots">
                        <span></span><span></span><span></span>
                    </span>
                </div>
            </div>
        `;
    }

    // ============================================================
    // CONSOLIDAR COMENTARIOS
    // ============================================================
    function consolidarComentarios(caja) {
        const comentarios = Array.isArray(caja.comentarios) ? [...caja.comentarios] : [];
        comentarios.sort((a, b) => {
            const fa = a.fecha ? new Date(a.fecha).getTime() : 0;
            const fb = b.fecha ? new Date(b.fecha).getTime() : 0;
            return fb - fa;
        });
        return comentarios;
    }

    // ============================================================
    // RENDERIZAR TARJETA DE CAJA
    // ============================================================
    function renderCajaCard(modulo) {
        const caja = cajaState[modulo.key];
        let innerHTML = '';

        if (!caja.loaded) {
            innerHTML = `
                <div class="caja-full-loading">
                    <div class="loader"></div>
                    <div class="loading-text">Cargando ${modulo.titulo}...</div>
                </div>
            `;
        }
        else if (!caja.data) {
            innerHTML = `
                <div class="caja-full-empty">
                    <i class="fas fa-inbox"></i>
                    <p>Sin elementos en la caja</p>
                    <small>Envía elementos desde el módulo ${modulo.titulo}</small>
                </div>
            `;
        }
        else {
            const data = caja.data;
            const tieneGigets   = data.gigets   && data.gigets.length   > 0;
            const tieneGraficas = data.graficas && data.graficas.length > 0;

            const comentarios = consolidarComentarios(caja);
            const tieneNotas = comentarios.length > 0;

            // ═══ GIGETS ═══
            innerHTML += `
                <div class="caja-section section-gigets">
                    <div class="caja-section-title gigets">
                        <i class="fas fa-square"></i> GIGETS
                    </div>
            `;
            if (tieneGigets) {
                innerHTML += `
                    <div class="caja-section-content scroll-vertical">
                        <div class="caja-full-gigets-grid">
                `;
                data.gigets.forEach((g) => {
                    const color = g.color || 'teal';
                    // 🔥 Número completo con separador de miles
                    const valor = formatNumero(g.value || 0);
                    const titulo = escapeHtml(g.title || 'Sin título');
                    innerHTML += `
                        <div class="caja-full-giget">
                            <div class="giget-label" title="${titulo}">${titulo}</div>
                            <div class="giget-value ${color}">${valor}</div>
                        </div>
                    `;
                });
                innerHTML += `</div></div>`;
            } else {
                innerHTML += renderPlaceholder('fa-square', 'Sin gigets');
            }
            innerHTML += `</div>`;

            // ═══ GRÁFICAS ═══
            innerHTML += `
                <div class="caja-section section-graficas">
                    <div class="caja-section-title graficas">
                        <i class="fas fa-chart-bar"></i> GRÁFICAS
                    </div>
            `;
            if (tieneGraficas) {
                innerHTML += `
                    <div class="caja-section-content scroll-vertical">
                        <div class="graficas-grid">
                `;
                data.graficas.forEach((g, idx) => {
                    innerHTML += `
                        <div class="caja-full-grafica">
                            <div class="grafica-title">
                                <i class="fas fa-chart-bar"></i> ${escapeHtml(g.title || 'Gráfica')}
                            </div>
                            <div class="grafica-wrapper">
                                <canvas id="cajaChart_${modulo.key}_${idx}"
                                        data-module="${modulo.key}"
                                        data-grafica-idx="${idx}"></canvas>
                            </div>
                        </div>
                    `;
                });
                innerHTML += `</div></div>`;
            } else {
                innerHTML += renderPlaceholder('fa-chart-bar', 'Sin gráficas');
            }
            innerHTML += `</div>`;

            // ═══ NOTAS ═══
            innerHTML += `
                <div class="caja-section section-notas">
                    <div class="caja-section-title notas">
                        <i class="fas fa-comment-alt"></i> NOTAS
                        ${tieneNotas ? `<span class="caja-notas-count">${comentarios.length}</span>` : ''}
                    </div>
            `;
            if (tieneNotas) {
                const colorMap = {
                    teal: '#14b8a6', blue: '#3b82f6', green: '#22c55e',
                    orange: '#f59e0b', purple: '#8b5cf6', red: '#ef4444'
                };
                innerHTML += `
                    <div class="caja-section-content scroll-vertical">
                        <div class="caja-notas-container">
                `;
                comentarios.forEach((com) => {
                    const color = colorMap[com.color] || '#3b82f6';
                    const fecha = formatearFechaComentario(com.fecha);
                    innerHTML += `
                        <div class="caja-full-comentario" style="border-left-color:${color};">
                            <div class="comentario-titulo" style="color:${color};">
                                <i class="fas fa-comment-alt"></i>
                                <span class="comentario-titulo-text">${escapeHtml(com.titulo || 'Comentario')}</span>
                                ${fecha ? `<span class="comentario-fecha">${fecha}</span>` : ''}
                            </div>
                            <div class="comentario-texto">${escapeHtml(com.texto || '')}</div>
                        </div>
                    `;
                });
                innerHTML += `</div></div>`;
            } else {
                innerHTML += renderPlaceholder('fa-comment-alt', 'Sin notas');
            }
            innerHTML += `</div>`;
        }

        // PILLS
        const numGigets   = (caja.data && caja.data.gigets)   ? caja.data.gigets.length   : 0;
        const numGraficas = (caja.data && caja.data.graficas) ? caja.data.graficas.length : 0;
        const numNotas    = caja.comentarios ? caja.comentarios.length : 0;

        return `
            <div class="caja-slide" data-module="${modulo.key}">
                <div class="caja-card-header">
                    <div class="caja-card-title-block">
                        <div class="caja-card-icon ${modulo.color}">
                            <i class="fas ${modulo.icono}"></i>
                        </div>
                        <div class="caja-card-title">
                            <h2>${modulo.titulo}</h2>
                            <div class="caja-card-sub">
                                <i class="fas fa-circle" style="font-size:5px;"></i>
                                ${modulo.desc}
                            </div>
                        </div>
                    </div>
                    <div class="caja-card-stats">
                        ${numGigets > 0 ? `<span class="caja-pill pill-gigets"><i class="fas fa-square"></i> ${numGigets} GIGET${numGigets !== 1 ? 'S' : ''}</span>` : ''}
                        ${numGraficas > 0 ? `<span class="caja-pill pill-graficas"><i class="fas fa-chart-bar"></i> ${numGraficas} GRÁFICA${numGraficas !== 1 ? 'S' : ''}</span>` : ''}
                        ${numNotas > 0 ? `<span class="caja-pill pill-notas"><i class="fas fa-comment-alt"></i> ${numNotas} NOTA${numNotas !== 1 ? 'S' : ''}</span>` : ''}
                    </div>
                </div>
                <div class="caja-card-body">
                    ${innerHTML}
                </div>
            </div>
        `;
    }

    // ============================================================
    // RENDERIZAR CARRUSEL
    // ============================================================
    function renderCajaCarousel() {
        const track = document.getElementById('cajaTrack');
        if (!track) return;
        track.innerHTML = MODULOS_CAJA.map(m => renderCajaCard(m)).join('');
        renderDots();
        updateCarouselPosition();
        setTimeout(() => {
            renderAllCajaCharts();
        }, 100);
    }

    function renderDots() {
        const dotsContainer = document.getElementById('cajaDots');
        if (!dotsContainer) return;
        dotsContainer.innerHTML = MODULOS_CAJA.map((m, idx) => {
            const active = idx === currentSlide ? 'active' : '';
            return `
                <button class="caja-dot ${active}" data-index="${idx}">
                    <span class="dot-indicator-circle"></span>
                    <i class="fas ${m.icono} dot-icon"></i>
                    <span class="dot-label">${m.titulo.toUpperCase()}</span>
                </button>
            `;
        }).join('');

        dotsContainer.querySelectorAll('.caja-dot').forEach(btn => {
            btn.addEventListener('click', function() {
                const idx = parseInt(this.dataset.index, 10);
                goToSlide(idx);
            });
        });
    }

    function goToSlide(idx) {
        const total = MODULOS_CAJA.length;
        if (idx < 0) idx = total - 1;
        if (idx >= total) idx = 0;
        currentSlide = idx;
        updateCarouselPosition();
        renderDots();

        const moduleKey = MODULOS_CAJA[idx].key;
        setTimeout(() => {
            Object.entries(cajaChartInstances).forEach(([key, chart]) => {
                if (key.startsWith(`cajaChart_${moduleKey}_`) && chart) {
                    chart.resize();
                }
            });
        }, 120);
    }

    function updateCarouselPosition() {
        const track = document.getElementById('cajaTrack');
        if (!track) return;
        const offset = -currentSlide * 100;
        track.style.transform = `translateX(${offset}%)`;
    }

    function nextSlide() { goToSlide(currentSlide + 1); }
    function prevSlide() { goToSlide(currentSlide - 1); }

    // ============================================================
    // AUTO-AVANCE
    // ============================================================
    function startAutoAdvance() {
        clearInterval(autoAdvanceTimer);
        if (MODULOS_CAJA.length <= 1) return;
        autoAdvanceTimer = setInterval(() => {
            if (autoAdvancePaused) return;
            currentSlide = (currentSlide + 1) % MODULOS_CAJA.length;
            updateCarouselPosition();
            renderDots();

            const moduleKey = MODULOS_CAJA[currentSlide].key;
            setTimeout(() => {
                Object.entries(cajaChartInstances).forEach(([key, chart]) => {
                    if (key.startsWith(`cajaChart_${moduleKey}_`) && chart) {
                        chart.resize();
                    }
                });
            }, 120);
        }, 10000);
    }

    function pauseAutoAdvance()  { autoAdvancePaused = true;  }
    function resumeAutoAdvance() { autoAdvancePaused = false; }

    // ============================================================
    // RENDERIZAR GRÁFICAS
    // ============================================================
    function renderAllCajaCharts() {
        Object.values(cajaChartInstances).forEach(c => { if (c) c.destroy(); });
        cajaChartInstances = {};

        MODULOS_CAJA.forEach(modulo => {
            const caja = cajaState[modulo.key];
            if (!caja || !caja.data || !caja.data.graficas || caja.data.graficas.length === 0) return;

            caja.data.graficas.forEach((g, idx) => {
                const canvasId = `cajaChart_${modulo.key}_${idx}`;
                const canvas = document.getElementById(canvasId);
                if (!canvas) return;
                try {
                    renderCajaChart(canvas, canvasId, modulo, g);
                } catch (e) {
                    console.warn(`Error renderizando chart ${canvasId}:`, e);
                }
            });
        });
    }

    function renderCajaChart(canvas, canvasId, modulo, grafica) {
        const graficaType = grafica.tipo || 'bar';
        const labels = (grafica.labels && grafica.labels.length) ? grafica.labels : ['Sin datos'];
        const values = (grafica.values && grafica.values.length) ? grafica.values : [0];

        const palette = ['#3b82f6', '#8b5cf6', '#06b6d4', '#22c55e', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6'];
        const bgColors = values.map((_, i) => palette[i % palette.length]);

        const isPieLike = ['doughnut', 'pie', 'polarArea'].indexOf(graficaType) >= 0;
        const isRadar = graficaType === 'radar';
        const colors = getChartColors();

        let scalesConfig = undefined;
        if (isRadar) {
            scalesConfig = {
                r: {
                    grid: { color: colors.grid },
                    ticks: { color: colors.text, font: { size: 7 }, backdropColor: 'transparent' },
                    pointLabels: { color: colors.text, font: { size: 8 } }
                }
            };
        } else if (!isPieLike) {
            scalesConfig = {
                y: {
                    beginAtZero: true,
                    grid: { color: colors.grid },
                    ticks: {
                        color: colors.text,
                        font: { size: 7 },
                        // 🔥 Números completos en eje Y también
                        callback: function(value) {
                            return formatNumero(value);
                        }
                    }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: colors.text, font: { size: 7 }, maxRotation: 45 }
                }
            };
        }

        const chartConfig = {
            type: graficaType,
            data: {
                labels: labels,
                datasets: [{
                    data: values,
                    backgroundColor: isPieLike ? bgColors : bgColors.map(c => c + 'AA'),
                    borderColor: bgColors,
                    borderWidth: 1.5,
                    borderRadius: graficaType === 'bar' ? 5 : undefined,
                    barPercentage: graficaType === 'bar' ? 0.65 : undefined,
                    tension: graficaType === 'line' ? 0.35 : undefined,
                    fill: isRadar ? true : false
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 500 },
                plugins: {
                    legend: {
                        display: isPieLike || isRadar,
                        position: 'bottom',
                        labels: {
                            color: colors.text,
                            font: { size: 7, weight: '600' },
                            boxWidth: 8, padding: 5,
                            usePointStyle: true, pointStyle: 'circle'
                        }
                    },
                    tooltip: {
                        backgroundColor: isDarkMode ? 'rgba(15,23,42,0.98)' : 'rgba(255,255,255,0.98)',
                        titleColor: isDarkMode ? '#e8edf5' : '#0a0e1a',
                        bodyColor: isDarkMode ? '#e8edf5' : '#0a0e1a',
                        borderColor: isDarkMode ? 'rgba(96,165,250,0.3)' : 'rgba(59,130,246,0.2)',
                        borderWidth: 1, cornerRadius: 8, padding: 8,
                        titleFont: { size: 9, weight: '700' },
                        bodyFont: { size: 9, weight: '500' },
                        // 🔥 Números completos en tooltip
                        callbacks: {
                            label: function(context) {
                                const label = context.label || '';
                                const value = context.parsed.y !== undefined ? context.parsed.y
                                            : context.parsed;
                                return `${label}: ${formatNumero(value)}`;
                            }
                        }
                    }
                },
                cutout: graficaType === 'doughnut' ? '62%' : undefined
            }
        };

        if (scalesConfig !== undefined) {
            chartConfig.options.scales = scalesConfig;
        }

        cajaChartInstances[canvasId] = new Chart(canvas, chartConfig);
    }

    // ============================================================
    // ACTUALIZAR UI
    // ============================================================
    function updateStatus() {
        const totalModulos = MODULOS_CAJA.length;
        const cargados = MODULOS_CAJA.filter(m => cajaState[m.key].loaded).length;
        const conDatos = MODULOS_CAJA.filter(m => cajaState[m.key].data).length;

        const now = new Date();
        const fechaEl = document.getElementById('currentDate');
        const updateEl = document.getElementById('lastUpdate');
        const dataStatusEl = document.getElementById('dataStatus');
        const statusTextEl = document.getElementById('statusText');
        const statusDotEl = document.getElementById('statusDot');

        if (fechaEl) fechaEl.textContent = now.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' }).toUpperCase();
        if (updateEl) updateEl.textContent = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

        const allLoaded = cargados === totalModulos;
        if (dataStatusEl) dataStatusEl.textContent = allLoaded ? `${conDatos}/${totalModulos} CON DATOS` : 'CARGANDO...';

        if (statusTextEl) statusTextEl.textContent = allLoaded
            ? `${conDatos} CAJA${conDatos !== 1 ? 'S' : ''} CON DATOS`
            : `CARGANDO ${cargados}/${totalModulos}...`;
        if (statusDotEl) statusDotEl.className = `status-dot ${allLoaded ? 'online' : 'offline'}`;
    }

    // ============================================================
    // ACTUALIZAR EN BACKGROUND (sin flash)
    // ============================================================
    async function actualizarEnBackground() {
        if (fetchEnCurso) {
            console.log('⏭️ Fetch en curso · salto este ciclo');
            return;
        }
        fetchEnCurso = true;
        const t0 = performance.now();

        const antes = JSON.stringify(cajaState);
        await fetchAllCajas();
        const despues = JSON.stringify(cajaState);
        const ms = (performance.now() - t0).toFixed(0);

        if (antes === despues) {
            console.log(`✅ Sin cambios (${ms}ms) · DOM intacto`);
        } else {
            console.log(`🆕 Cambios detectados (${ms}ms) · re-renderizando`);
            renderCajaCarousel();
        }

        updateStatus();
        fetchEnCurso = false;
    }

    // ============================================================
    // CARGA PRINCIPAL
    // ============================================================
    async function loadAllData() {
        if (fetchEnCurso) {
            console.log('⏭️ Fetch en curso · salto carga inicial');
            return;
        }
        fetchEnCurso = true;
        console.log('📦 Executive Command Center - Cargando cajas...');
        const t0 = performance.now();

        if (!primeraCargaHecha) {
            renderCajaCarousel();
        }

        const antes = JSON.stringify(cajaState);
        await fetchAllCajas();
        const despues = JSON.stringify(cajaState);
        const ms = (performance.now() - t0).toFixed(0);

        if (!primeraCargaHecha || antes !== despues) {
            const conDatos = MODULOS_CAJA.filter(m => cajaState[m.key].data).length;
            console.log(`✅ loadAllData (${ms}ms) · ${conDatos}/${MODULOS_CAJA.length} con datos · re-render`);
            renderCajaCarousel();
        } else {
            console.log(`✅ loadAllData (${ms}ms) · sin cambios · DOM intacto`);
        }

        updateStatus();
        primeraCargaHecha = true;
        fetchEnCurso = false;
    }

    // ============================================================
    // HOVER PAUSE
    // ============================================================
    function setupHoverPause() {
        const viewport = document.getElementById('cajaViewport');
        if (!viewport) return;

        viewport.addEventListener('mouseenter', pauseAutoAdvance);
        viewport.addEventListener('mouseleave', resumeAutoAdvance);

        const dotsContainer = document.getElementById('cajaDots');
        if (dotsContainer) {
            dotsContainer.addEventListener('mouseenter', pauseAutoAdvance);
            dotsContainer.addEventListener('mouseleave', resumeAutoAdvance);
        }
    }

    // ============================================================
    // EVENTOS GLOBALES
    // ============================================================
    document.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') prevSlide();
        if (e.key === 'ArrowRight') nextSlide();
    });

    window.addEventListener('message', function(event) {
        const data = event.data;
        if (!data || !data.type) return;

        if (data.type === 'TOGGLE_THEME') {
            applyTheme(data.isDark);
            return;
        }

        if (data.type === 'MODULE_SHOWN' || data.type === 'MODULE_VISIBLE') {
            actualizarEnBackground();
            return;
        }

        if (data.type === 'FORCE_RELOAD') {
            primeraCargaHecha = false;
            loadAllData();
            return;
        }
    });

    document.addEventListener('visibilitychange', function() {
        if (!document.hidden) {
            actualizarEnBackground();
        }
    });

    // ============================================================
    // RESIZE GLOBAL
    // ============================================================
    let resizeTimeout = null;
    window.addEventListener('resize', function() {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            Object.values(cajaChartInstances).forEach(chart => {
                if (chart) chart.resize();
            });
        }, 200);
    });

    // ============================================================
    // INICIO
    // ============================================================
    console.log('📊 Executive Command Center - Iniciando (v9)');
    console.log('🌐 API_BASE:', API_BASE);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            loadAllData();
            startAutoAdvance();
            setupHoverPause();
        });
    } else {
        loadAllData();
        startAutoAdvance();
        setupHoverPause();
    }

    setInterval(() => { actualizarEnBackground(); }, 15000);

    if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'MODULO_READY', nombre: 'panel_ejecutivo' }, '*');
    }

})();