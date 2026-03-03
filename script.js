const fileinput = document.getElementById('fileInput');
const togglebtn = document.getElementById('toggleMode');
const modestatus = document.getElementById('modeStatus');
const durationselect = document.getElementById('viewDuration');
const ctx = document.getElementById('myChart').getContext('2d');

let mychart;
let eventsource;
let islive = true;
let viewhours = 2; // Default starting value based on HTML selection
let memoryHours = 2; // Tracks how much data we actually have in memory
let datamatrix = Array.from({ length: 14 }, () => []);
let timelabels = [];
let lineTimes = []; 
let isdragging = false;

// Convert luxon to standard timestamp utility
const getNowTs = () => luxon.DateTime.now().toSeconds();

function updatexaxisscale() {
    if (!mychart) return;
    if (viewhours === 'all') {
        mychart.options.scales.x.min = null;
        mychart.options.scales.x.max = null;
    } else {
        const hours = parseFloat(viewhours);
        const now = luxon.DateTime.now();
        const starttime = now.minus({ hours: hours });
        mychart.options.scales.x.min = starttime.toMillis();
        mychart.options.scales.x.max = now.toMillis();
    }
}

// Fetch historical data from the server
async function fetchHistory(startTs, endTs, intervalMins) {
    let url = `/api/history?interval=${intervalMins}`;
    if (startTs) url += `&start=${startTs}`;
    if (endTs) url += `&end=${endTs}`;
    
    try {
        const res = await fetch(url);
        const json = await res.json();
        return json.data || [];
    } catch (e) {
        console.error("Error fetching history:", e);
        return [];
    }
}

// Incorporate fetched rows into our data matrix
function ingestHistoricalData(rows, prepend = false) {
    const newLabels = [];
    const newMatrix = Array.from({ length: 14 }, () => []);
    
    rows.forEach(row => {
        newLabels.push(row[0]);
        for (let i = 0; i < 14; i++) {
            newMatrix[i].push(row[i + 1]);
        }
    });

    if (prepend) {
        timelabels = newLabels.concat(timelabels);
        for (let i = 0; i < 14; i++) {
            datamatrix[i] = newMatrix[i].concat(datamatrix[i]);
        }
    } else {
        timelabels = timelabels.concat(newLabels);
        for (let i = 0; i < 14; i++) {
            datamatrix[i] = datamatrix[i].concat(newMatrix[i]);
        }
    }
}

function trimMemory(keepHours) {
    if (keepHours === 'all') return;
    const cutoffMs = luxon.DateTime.now().minus({ hours: keepHours }).toMillis();
    
    let cutoffIndex = 0;
    for (let i = 0; i < timelabels.length; i++) {
        const tsMs = luxon.DateTime.fromFormat(timelabels[i], "MM/dd/yyyy HH:mm:ss").toMillis();
        if (tsMs >= cutoffMs) {
            cutoffIndex = i;
            break;
        }
    }
    
    if (cutoffIndex > 0) {
        timelabels = timelabels.slice(cutoffIndex);
        for (let i = 0; i < 14; i++) {
            datamatrix[i] = datamatrix[i].slice(cutoffIndex);
        }
    }
    memoryHours = keepHours;
}

if (durationselect) {
    durationselect.addEventListener('change', async (e) => {
        const newView = e.target.value === 'all' ? 'all' : parseFloat(e.target.value);
        
        // Show a loading state (optional but helpful)
        if (modestatus) modestatus.innerHTML = "status: <b>loading data...</b>";

        if (newView === 'all') {
            viewhours = 'all';
            memoryHours = 'all';
            timelabels = [];
            datamatrix = Array.from({ length: 14 }, () => []);
            const data = await fetchHistory(null, null, 5); // 5 min intervals for 'all'
            ingestHistoricalData(data);
        } else {
            // OPTIMIZATION: Instead of trying to prepend, 
            // just wipe and fetch a clean window for the new duration.
            // This prevents the "missing data" bug entirely.
            timelabels = [];
            datamatrix = Array.from({ length: 14 }, () => []);
            
            const startTs = getNowTs() - (newView * 3600);
            // Use 1 min interval for specific hour views
            const data = await fetchHistory(startTs, null, 1); 
            ingestHistoricalData(data);
            
            viewhours = newView;
            memoryHours = newView;
        }

        if (mychart) {
            updatexaxisscale();
            renderchart(timelabels, datamatrix);
        }
        
        if (modestatus) modestatus.innerHTML = islive ? "status: <b>live view</b>" : "status: <b>file mode</b>";
    });
}

async function startliveview() {
    islive = true;
    linetime = null;
    if (modestatus) modestatus.innerHTML = "status: <b>live view</b>";
    if (togglebtn) togglebtn.innerText = "switch to file upload";
    if (fileinput) fileinput.style.display = "none";

    // Initialize initial window data on load
    timelabels = [];
    datamatrix = Array.from({ length: 14 }, () => []);
    
    const initHours = durationselect ? (durationselect.value === 'all' ? 'all' : parseFloat(durationselect.value)) : 2;
    viewhours = initHours;
    
    if (initHours === 'all') {
        memoryHours = 'all';
        const data = await fetchHistory(null, null, 5);
        ingestHistoricalData(data);
    } else {
        memoryHours = initHours; // Standard initial load keeps memory == viewhours
        const startTs = getNowTs() - (initHours * 3600);
        const data = await fetchHistory(startTs, null, 1);
        ingestHistoricalData(data);
    }
    
    renderchart(timelabels, datamatrix);

    // Continue listening for live single-row updates
    if (eventsource) eventsource.close();
    eventsource = new EventSource("/stream");

    eventsource.onmessage = function(event) {
        if (!islive || event.data === "heartbeat") return;
        const { labels, datasetsdata } = processdata(event.data);

        if (labels.length > 0) {
            timelabels.push(labels[0]);
            for (let i = 0; i < 14; i++) {
                datamatrix[i].push(datasetsdata[i][0]);
            }

            // Only trim if memory is getting dangerously high (e.g., > 10,000 points)
            // This prevents the "chopping" bug you are seeing
            if (memoryHours !== 'all' && timelabels.length > 10000) {
                timelabels = timelabels.slice(2000); // Remove oldest 2000 points
                for (let i = 0; i < 14; i++) {
                    datamatrix[i] = datamatrix[i].slice(2000);
                }
            }

            if (mychart) {
                // CRITICAL: Update the X-axis scale so it slides forward with the new data
                updatexaxisscale(); 
                renderchart(timelabels, datamatrix);
            }
        }
    };
}

function stopliveview() {
    islive = false;
    linetime = null;
    if (modestatus) modestatus.innerHTML = "status: <b>file mode</b>";
    if (togglebtn) togglebtn.innerText = "back to live view";
    if (fileinput) fileinput.style.display = "inline-block";

    if (eventsource) {
        eventsource.close();
        eventsource = null;
    }

    timelabels = [];
    datamatrix = Array.from({ length: 14 }, () => []);
}

if (togglebtn) {
    togglebtn.addEventListener('click', () => {
        if (islive) stopliveview();
        else startliveview();
    });
}

if (fileinput) {
    fileinput.addEventListener('change', function(e) {
        if (islive) return; 
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            const { labels, datasetsdata } = processdata(event.target.result);
            renderchart(labels, datasetsdata);
        };
        reader.readAsText(file);
        e.target.value = '';
    });
}

window.onload = () => {
    startliveview();
};

function processdata(csvtext) {
    const lines = csvtext.trim().split('\n');
    const labels = [];
    const datasetsdata = Array.from({ length: 14 }, () => []);

    for (let i = 0; i < lines.length; i++) {
        const columns = lines[i].split(',');
        
        // Skip rows that don't have enough data
        if (columns.length < 15) continue; 

        let timestamp = columns[0].trim();
        
        // Skip header row
        if (timestamp.toLowerCase().startsWith('time')) continue;

        // Handle specific timestamp formatting if necessary
        if (timestamp.includes('_') && timestamp.includes('-')) {
            const [datepart, timepart] = timestamp.split('_');
            const [yy, mm, dd] = datepart.split('-');
            const [hh, min, ss] = timepart.split('-');
            timestamp = `${mm}/${dd}/20${yy} ${hh}:${min}:${ss}`;
        }

        let rowValid = true;
        const tempRowData = [];

        // Parse the 14 data columns
        for (let j = 0; j < 14; j++) {
            const val = parseFloat(columns[j + 1]);
            if (isNaN(val)) {
                rowValid = false;
                break;
            }
            tempRowData.push(val);
        }

        // Only push to main arrays if the entire row was valid numbers
        if (rowValid) {
            labels.push(timestamp);
            for (let j = 0; j < 14; j++) {
                datasetsdata[j].push(tempRowData[j]);
            }
        }
    }
    return { labels, datasetsdata };
}

const verticallineplugin = {
    id: 'verticalline',
    closeRects: [],

    afterEvent(chart, args) {
        const { event } = args;
        const { x, y } = event;
        const chartarea = chart.chartArea;

        if (event.type === 'mousedown') {
            for (let i = 0; i < this.closeRects.length; i++) {
                const rect = this.closeRects[i];
                if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) {
                    lineTimes.splice(i, 1);
                    this.closeRects.splice(i, 1);
                    isdragging = false;
                    chart.draw();
                    args.changed = true;
                    return;
                }
            }
            if (x >= chartarea.left && x <= chartarea.right && y >= chartarea.top && y <= chartarea.bottom) {
                let dragIndex = lineTimes.findIndex(t => Math.abs(chart.scales.x.getPixelForValue(t) - x) < 15);
                if (dragIndex !== -1) {
                    isdragging = dragIndex;
                } else if (lineTimes.length < 2) {
                    lineTimes.push(chart.scales.x.getValueForPixel(x));
                    isdragging = lineTimes.length - 1;
                } else {
                    let closest = 0;
                    let minDiff = Infinity;
                    lineTimes.forEach((t, i) => {
                        let diff = Math.abs(chart.scales.x.getPixelForValue(t) - x);
                        if (diff < minDiff) { minDiff = diff; closest = i; }
                    });
                    isdragging = closest;
                }
                args.changed = true;
            }
        } else if (event.type === 'mousemove') {
            const isOverX = this.closeRects.some(rect => x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h);
            chart.canvas.style.cursor = isOverX ? 'pointer' : 'default';
            if (isdragging !== false && isdragging !== null) {
                const boundedx = Math.max(chartarea.left, Math.min(x, chartarea.right));
                lineTimes[isdragging] = chart.scales.x.getValueForPixel(boundedx);
                args.changed = true;
            }
        } else if (event.type === 'mouseup' || event.type === 'mouseout') {
            isdragging = false;
        }
    },

    afterDraw(chart) {
        if (!lineTimes || lineTimes.length === 0) {
            this.closeRects = [];
            return;
        }

        const { ctx, chartArea: chartarea, data } = chart;
        this.closeRects = [];

        lineTimes.forEach((lTime, lineIndex) => {
            const targetx = chart.scales.x.getPixelForValue(lTime);
            const meta = chart.getDatasetMeta(0);
            if (!meta || meta.data.length === 0) return;

            let nearestindex = 0;
            let mindiff = Infinity;
            meta.data.forEach((point, index) => {
                const diff = Math.abs(point.x - targetx);
                if (diff < mindiff) { mindiff = diff; nearestindex = index; }
            });

            const snpx = meta.data[nearestindex].x;
            if (snpx < chartarea.left - 1 || snpx > chartarea.right + 1) return;

            // 1. Draw Vertical Line
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(snpx, chartarea.top);
            ctx.lineTo(snpx, chartarea.bottom);
            ctx.lineWidth = 2;
            ctx.strokeStyle = lineIndex === 0 ? 'rgba(255, 0, 0, 0.8)' : 'rgba(0, 123, 255, 0.8)';
            ctx.stroke();

            // 2. Draw Time Box
            ctx.font = 'bold 10px arial';
            const timeText = `time: ${data.labels[nearestindex]}`;
            const closeBtnText = "  [X]";
            const timeWidth = ctx.measureText(timeText).width;
            ctx.font = '900 14px arial';
            const closeWidth = ctx.measureText(closeBtnText).width;
            const totalW = timeWidth + closeWidth + 15;
            let boxX = snpx + 10;
            let boxY = chartarea.top + 10 + (lineIndex * 25); 
            if (boxX + totalW > chartarea.right) boxX = snpx - totalW - 10;
            const rect = { x: boxX, y: boxY - 10, w: totalW, h: 20 };
            this.closeRects.push(rect);
            ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
            ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
            ctx.fillStyle = 'white';
            ctx.font = 'bold 10px arial';
            ctx.textBaseline = 'middle';
            ctx.fillText(timeText, boxX + 5, boxY);
            ctx.fillStyle = 'red';
            ctx.font = '900 14px arial';
            ctx.fillText(closeBtnText, boxX + 5 + timeWidth, boxY);

            // 3. Collect and Resolve Data Labels
            
            let labelsToDraw = [];
            ctx.font = 'bold 10px arial';
            data.datasets.forEach((ds, i) => {
                const val = ds.data[nearestindex];
                if (val === null || isNaN(val)) return;
                const isvacuum = i < 2;
                const textval = isvacuum ? val.toExponential(2) : val.toFixed(2);
                const labelText = `${ds.label}: ${textval}`;
                const yscale = chart.scales[`y${i}`];
                let ypx = Math.max(chartarea.top, Math.min(yscale.getPixelForValue(val), chartarea.bottom));

                // Draw small dot on line
                ctx.beginPath();
                ctx.arc(snpx, ypx, 3, 0, 2 * Math.PI);
                ctx.fillStyle = ds.borderColor;
                ctx.fill();

                labelsToDraw.push({
                    text: labelText,
                    color: ds.borderColor,
                    trueY: ypx,
                    ypx: ypx,
                    width: ctx.measureText(labelText).width + 10
                });
            });

            // Collision resolution
            labelsToDraw.sort((a, b) => a.ypx - b.ypx);
            const boxHeight = 22;
            const topMargin = chartarea.top + 60; // Extra room for time boxes
            for (let i = 0; i < labelsToDraw.length; i++) {
                let minY = (i === 0) ? topMargin : labelsToDraw[i - 1].ypx + boxHeight;
                if (labelsToDraw[i].ypx < minY) labelsToDraw[i].ypx = minY;
            }

            // Render Labels
            labelsToDraw.forEach(item => {
                let valBoxX = snpx + 15;
                let isFlipped = false;
                if (valBoxX + item.width > chartarea.right) {
                    valBoxX = snpx - item.width - 15;
                    isFlipped = true;
                }
                ctx.beginPath();
                ctx.moveTo(snpx, item.trueY);
                ctx.lineTo(isFlipped ? valBoxX + item.width : valBoxX, item.ypx);
                ctx.strokeStyle = 'rgba(0,0,0,0.4)';
                ctx.stroke();
                ctx.fillStyle = 'rgba(0,0,0,0.8)';
                ctx.fillRect(valBoxX, item.ypx - 10, item.width, 20);
                ctx.fillStyle = item.color;
                ctx.fillText(item.text, valBoxX + 5, item.ypx);
            });
            ctx.restore();
        });
    }
};

const arrowplugin = {
    id: 'axisarrows',
    afterDraw: (chart) => {
        const { ctx, scales, data } = chart;
        data.datasets.forEach((dataset, i) => {
            const meta = chart.getDatasetMeta(i);
            const scale = scales[dataset.yAxisID];
            const validdata = dataset.data.filter(v => v !== null && !isNaN(v));
            if (validdata.length === 0 || meta.hidden) return;

            const lastvalue = validdata[validdata.length - 1];
            const ypos = scale.getPixelForValue(lastvalue);
            const xpos = scale.left; 

            ctx.save();
            ctx.fillStyle = dataset.borderColor;
            ctx.strokeStyle = dataset.borderColor;
            ctx.lineWidth = 30;

            ctx.beginPath();
            ctx.moveTo(xpos, ypos);
            ctx.lineTo(xpos + 16, ypos - 15);
            ctx.lineTo(xpos + 16, ypos + 15);
            ctx.closePath();
            ctx.fill();

            const nextscaleid = `y${i + 1}`;
            const nextscale = scales[nextscaleid];
            const endx = nextscale ? nextscale.left : xpos + 55;

            ctx.beginPath();
            ctx.moveTo(xpos + 15, ypos);
            ctx.lineTo(endx, ypos);
            ctx.stroke();

            const isvacuum = i < 2;
            const textvalue = isvacuum ? lastvalue.toExponential(1) : lastvalue.toFixed(1);

            ctx.fillStyle = 'white';
            ctx.font = 'bold 9px arial';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            ctx.fillText(textvalue, endx - 15, ypos);
            ctx.restore();
        });
    }
};

function renderchart(labels, alldata) {
    const names = [
        "high vacuum", "low vacuum", "plate pv", "plate sp", 
        "plate profile sp", "plate target sp", "shroud pv", "shroud sp", 
        "shroud profile sp", "shroud profile target sp", "rtd 1", "rtd 2", "rtd 3", "rtd 4"
    ];

    const colors = [
        '#e6194b', '#3cb44b', '#f58231', '#4363d8', '#ffe119', 
        '#911eb4', '#46f0f0', '#f032e6', '#bcf60c', '#fabebe', 
        '#008080', '#e6beff', '#9a6324', '#000000'
    ];

    const nowstr = new Date().toLocaleTimeString([], { hour12: false });
    const fullaxistitle = `time (hh:mm)\nlast update: ${nowstr}`;

    if (mychart) {
        mychart.data.labels = labels;
        mychart.data.datasets.forEach((dataset, i) => {
            dataset.data = alldata[i];
        });
        mychart.options.scales.x.title.text = fullaxistitle;
        
        updatexaxisscale();
        
        mychart.update('none'); 
        return; 
    }

    const datasets = names.map((name, i) => ({
        label: name,
        data: alldata[i],
        borderColor: colors[i],
        tension: 0.1,
        pointRadius: 0,
        yAxisID: `y${i}`, 
    }));

    const yscales = {};
    names.forEach((name, i) => {
        const isvacuum = i < 2;
        const istemp = i >=10 && i <= 13;
        yscales[`y${i}`] = {
            type: isvacuum ? 'logarithmic' : 'linear',
            position: 'right',
            display: true,
            min: isvacuum ? 1e-7 : istemp ? -150 : -175, 
            max: isvacuum ? 1000 : istemp ? 150 : 175,
            title: { 
                display: true, 
                text: name, 
                color: colors[i],
                font: { size: 10 },
                align: 'end',
                padding: { top: 50 }
            },
            ticks: { 
                color: colors[i],
                font: { size: 9 },
                padding: 20,
                callback: function(value) {
                    if (isvacuum) return value.toExponential();
                    return value;
                }
            },
            grid: {
                drawOnChartArea: i === 0,
                color: 'rgba(0,0,0,0.1)'
            },
            border: { color: colors[i] }
        };
    });

    mychart = new Chart(ctx, {
        type: 'line',
        data: { labels: labels, datasets: datasets },
        plugins: [arrowplugin, verticallineplugin], 
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false, 
            events: ['mousemove', 'mouseout', 'click', 'touchstart', 'touchmove', 'mousedown', 'mouseup'], 
            layout: {
                padding: { right: 10, bottom: 50 }
            },
            plugins: {
                decimation: {
                    enabled: true,
                    algorithm: 'lttb', // Largest Triangle Three Buckets (best for time series)
                    samples: 500 // Max points to show per dataset
                },
                legend: { display: false },
                tooltip: { enabled: false } 
            },
            scales: {
                x: {
                    type: 'time',
                    time: {
                        parser: 'MM/dd/yyyy HH:mm:ss', 
                        unit: 'minute',
                        displayFormats: { minute: 'HH:mm' }
                    },
                    title: { 
                        display: true, 
                        text: fullaxistitle,
                        font: { size: 12, lineheight: 1.5 }
                    },
                    ticks: { stepSize: 15, autoskip: false }
                },
                ...yscales
            }
        }
    });

    updatexaxisscale();
    mychart.update('none');
}