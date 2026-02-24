const fileInput = document.getElementById('fileInput');
const ctx = document.getElementById('myChart').getContext('2d');
let myChart;
let autoReloadInterval;

const DEFAULT_FILE = 'TVAC_Log_26-02-19_12-09-21_UPDATING.CSV';
const RELOAD_INTERVAL_MS = 2000; // 2 seconds

/**
 * Fetches and renders data from a remote URL
 */
function loadRemoteData(url) {
    // Add a timestamp to bypass browser cache
    const cacheBuster = url.includes('?') ? `&t=${Date.now()}` : `?t=${Date.now()}`;
    
    fetch(url + cacheBuster)
        .then(response => {
            if (!response.ok) throw new Error("File not found");
            return response.text();
        })
        .then(csvText => {
            const { labels, datasetsData } = processData(csvText);
            renderChart(labels, datasetsData);
        })
        .catch(error => {
            console.error("Error loading CSV:", error);
            // Show placeholder only if the chart doesn't exist yet
            if (!myChart) {
                const placeholderLabels = Array.from({length: 10}, (_, i) => `2026-02-19 10:${15+i}:00`);
                const placeholderData = Array.from({length: 14}, () => Array(10).fill(0));
                renderChart(placeholderLabels, placeholderData);
            }
        });
}

// Initialization
window.onload = () => {
    // Initial load
    loadRemoteData(DEFAULT_FILE);
    
    // Set up auto-reload every X seconds
    autoReloadInterval = setInterval(() => {
        loadRemoteData(DEFAULT_FILE);
    }, RELOAD_INTERVAL_MS);
};

// Handle manual file uploads
fileInput.addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file) return;

    // Stop auto-reload when a local file is manually uploaded 
    // to prevent the remote file from overwriting the manual view
    if (autoReloadInterval) {
        clearInterval(autoReloadInterval);
        console.log("Auto-reload disabled due to manual file upload.");
    }

    const reader = new FileReader();
    reader.onload = (event) => {
        const { labels, datasetsData } = processData(event.target.result);
        renderChart(labels, datasetsData);
    };
    reader.readAsText(file);
});

function processData(csvText) {
    const lines = csvText.trim().split('\n');
    const labels = [];
    const datasetsData = Array.from({ length: 14 }, () => []);

    const hasHeader = lines[0].toLowerCase().startsWith('time');
    const startIndex = hasHeader ? 1 : 0;

    for (let i = startIndex; i < lines.length; i++) {
        const columns = lines[i].split(',');
        if (columns.length < 15) continue;

        let timestamp = columns[0].trim();
        if (timestamp === "") continue;

        if (timestamp.includes('_') && timestamp.includes('-')) {
            const [datePart, timePart] = timestamp.split('_');
            const [yy, mm, dd] = datePart.split('-');
            const [hh, min, ss] = timePart.split('-');
            timestamp = `${mm}/${dd}/20${yy} ${hh}:${min}:${ss}`;
        }

        labels.push(timestamp);
        
        for (let j = 0; j < 14; j++) {
            datasetsData[j].push(parseFloat(columns[j + 1]));
        }
    }
    
    return { labels, datasetsData };
}

const arrowPlugin = {
    id: 'axisArrows',
    afterDraw: (chart) => {
        const { ctx, scales, data } = chart;

        data.datasets.forEach((dataset, i) => {
            const meta = chart.getDatasetMeta(i);
            const scale = scales[dataset.yAxisID];
            
            const validData = dataset.data.filter(v => v !== null && !isNaN(v));
            if (validData.length === 0 || meta.hidden) return;

            const lastValue = validData[validData.length - 1];
            const yPos = scale.getPixelForValue(lastValue);
            const xPos = scale.left; 

            ctx.save();
            ctx.fillStyle = dataset.borderColor;
            ctx.strokeStyle = dataset.borderColor;
            ctx.lineWidth = 30;

            ctx.beginPath();
            ctx.moveTo(xPos, yPos);
            ctx.lineTo(xPos + 16, yPos - 15);
            ctx.lineTo(xPos + 16, yPos + 15);
            ctx.closePath();
            ctx.fill();

            const nextScaleId = `y${i + 1}`;
            const nextScale = scales[nextScaleId];
            const endX = nextScale ? nextScale.left : xPos + 55;

            ctx.beginPath();
            ctx.moveTo(xPos + 15, yPos);
            ctx.lineTo(endX, yPos);
            ctx.stroke();

            const isVacuum = i < 2;
            const textValue = isVacuum ? lastValue.toExponential(1) : lastValue.toFixed(1);

            ctx.fillStyle = 'white';
            ctx.font = 'bold 9px Arial';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            ctx.fillText(textValue, endX - 15, yPos);

            ctx.restore();
        });
    }
};

function renderChart(labels, allData) {
    const names = [
        "High Vacuum", "Low Vacuum", "Plate PV", "Plate SP", 
        "Plate Profile SP", "Plate Target SP", "Shroud PV", "Shroud SP", 
        "Shroud Profile SP", "Shroud Profile Target SP", "RTD 1", "RTD 2", "RTD 3", "RTD 4"
    ];

    const colors = [
        '#e6194b', '#3cb44b', '#f58231', '#4363d8', '#ffe119', 
        '#911eb4', '#46f0f0', '#f032e6', '#bcf60c', '#fabebe', 
        '#008080', '#e6beff', '#9a6324', '#000000'
    ];

    if (myChart) {
        const currentLen = myChart.data.labels.length;
        const newLen = labels.length;

        // 1. Skip entirely if the CSV size and the last row hasn't changed
        if (currentLen > 0 && currentLen === newLen && myChart.data.labels[currentLen - 1] === labels[newLen - 1]) {
            return; // No new data, ignore update to stop flickering
        }

        // 2. If new data was added, append it smoothly instead of fully replacing arrays
        if (currentLen > 0 && newLen > currentLen && myChart.data.labels[0] === labels[0]) {
            // Push new timestamps
            for (let i = currentLen; i < newLen; i++) {
                myChart.data.labels.push(labels[i]);
            }
            // Push new data points for each dataset
            myChart.data.datasets.forEach((dataset, i) => {
                for (let j = currentLen; j < newLen; j++) {
                    dataset.data.push(allData[i][j]);
                }
            });
        } 
        // 3. Fallback: If it's a completely different or smaller file, replace arrays fully
        else {
            myChart.data.labels = labels;
            myChart.data.datasets.forEach((dataset, i) => {
                dataset.data = allData[i];
            });
        }

        // 'none' prevents animation delays during constant polling
        myChart.update('none'); 
        return; 
    }

    // This code only runs the FIRST time the chart is rendered
    const datasets = names.map((name, i) => ({
        label: name,
        data: allData[i],
        borderColor: colors[i],
        tension: 0.1,
        pointRadius: 0,
        yAxisID: `y${i}`, 
    }));

    const yScales = {};
    names.forEach((name, i) => {
        const isVacuum = i < 2;
        yScales[`y${i}`] = {
            type: isVacuum ? 'logarithmic' : 'linear',
            position: 'right',
            display: true,
            min: isVacuum ? 1e-7 : undefined, 
            max: isVacuum ? 1000 : undefined,
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
                    if (isVacuum) return value.toExponential();
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

    myChart = new Chart(ctx, {
        type: 'line',
        data: { labels: labels, datasets: datasets },
        plugins: [arrowPlugin], 
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false, 
            layout: {
                padding: { 
                    right: 10,
                    bottom: 50
                }
            },
            plugins: {
                legend: { display: false }
            },
            scales: {
                x: {
                    type: 'time',
                    time: {
                        parser: 'MM/dd/yyyy HH:mm:ss', 
                        unit: 'minute',
                        displayFormats: {
                            minute: 'HH:mm' 
                        }
                    },
                    title: {
                        display: true,
                        text: 'Time (HH:mm)'
                    },
                    ticks: {
                        stepSize: 15,
                        autoSkip: false,
                    }
                },
                ...yScales
            }
        }
    });
}