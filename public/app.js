/**
 * Main Alpine.js Application
 */

function app() {
    return {
        view: 'dashboard',
        toast: null,
        status: null,
        accounts: [],
        logs: [],
        models: [],
        claudeConfig: null,
        strategyInfo: null,
        selectedStrategy: '',
        usageChart: null,

        // Add account
        showAddModal: false,
        addStartUrl: 'https://view.awsapps.com/start',
        addRegion: 'us-east-1',
        addFlow: null,
        addPollInterval: null,

        // Log filters
        logFilter: { status: '' },

        async init() {
            await this.refresh();
            // Auto-refresh every 5 seconds
            setInterval(() => this.refresh(), 5000);
        },

        async refresh() {
            try {
                const [statusRes, accountsRes, modelsRes] = await Promise.all([
                    fetch('/api/status'),
                    fetch('/api/accounts'),
                    fetch('/api/models')
                ]);
                this.status = await statusRes.json();
                this.accounts = await accountsRes.json();
                this.models = await modelsRes.json();

                if (this.view === 'logs') {
                    await this.fetchLogs();
                }
                if (this.view === 'settings') {
                    await this.fetchSettings();
                }
                if (this.view === 'dashboard') {
                    await this.updateChart();
                }
            } catch (err) {
                console.error('Refresh error:', err);
            }
        },

        async fetchLogs() {
            try {
                const params = new URLSearchParams();
                if (this.logFilter.status) params.set('status', this.logFilter.status);
                params.set('limit', '200');
                const res = await fetch('/api/logs?' + params.toString());
                this.logs = await res.json();
            } catch (err) {
                console.error('Fetch logs error:', err);
            }
        },

        async fetchSettings() {
            try {
                const [configRes, stratRes] = await Promise.all([
                    fetch('/api/claude-config'),
                    fetch('/api/strategy')
                ]);
                this.claudeConfig = await configRes.json();
                this.strategyInfo = await stratRes.json();
                this.selectedStrategy = this.strategyInfo.current;
            } catch (err) {
                console.error('Fetch settings error:', err);
            }
        },

        async updateChart() {
            try {
                const res = await fetch('/api/stats/history');
                const data = await res.json();

                const now = new Date();
                const labels = [];
                const values = [];

                // Last 24 hours
                for (let i = 23; i >= 0; i--) {
                    const hour = new Date(now);
                    hour.setHours(hour.getHours() - i);
                    hour.setMinutes(0, 0, 0);
                    const key = hour.toISOString();

                    labels.push(hour.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
                    values.push(data[key]?._total || 0);
                }

                const canvas = document.getElementById('usageChart');
                if (!canvas) return;

                if (this.usageChart) {
                    this.usageChart.data.labels = labels;
                    this.usageChart.data.datasets[0].data = values;
                    this.usageChart.update('none');
                } else {
                    this.usageChart = new Chart(canvas, {
                        type: 'bar',
                        data: {
                            labels,
                            datasets: [{
                                label: 'Requests',
                                data: values,
                                backgroundColor: 'rgba(0, 212, 255, 0.3)',
                                borderColor: 'rgba(0, 212, 255, 0.8)',
                                borderWidth: 1,
                                borderRadius: 3
                            }]
                        },
                        options: {
                            responsive: true,
                            plugins: { legend: { display: false } },
                            scales: {
                                x: {
                                    grid: { color: 'rgba(255,255,255,0.03)' },
                                    ticks: { color: '#6b7280', font: { size: 9 } }
                                },
                                y: {
                                    beginAtZero: true,
                                    grid: { color: 'rgba(255,255,255,0.03)' },
                                    ticks: { color: '#6b7280', font: { size: 9 }, stepSize: 1 }
                                }
                            }
                        }
                    });
                }
            } catch (err) {
                console.error('Chart error:', err);
            }
        },

        // Account actions
        async toggleAccount(acc) {
            try {
                await fetch(`/api/accounts/${acc.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled: !acc.enabled })
                });
                acc.enabled = !acc.enabled;
                this.showToast('success', `Account ${acc.enabled ? 'enabled' : 'disabled'}`);
            } catch (err) {
                this.showToast('error', err.message);
            }
        },

        async deleteAccount(id) {
            if (!confirm('Remove this account?')) return;
            try {
                await fetch(`/api/accounts/${id}`, { method: 'DELETE' });
                this.accounts = this.accounts.filter(a => a.id !== id);
                this.showToast('success', 'Account removed');
            } catch (err) {
                this.showToast('error', err.message);
            }
        },

        async refreshAccount(id) {
            try {
                const res = await fetch(`/api/accounts/${id}/refresh`, { method: 'POST' });
                const data = await res.json();
                if (res.ok) {
                    this.showToast('success', 'Token refreshed');
                } else {
                    this.showToast('error', data.error);
                }
            } catch (err) {
                this.showToast('error', err.message);
            }
        },

        async startAddAccount() {
            try {
                const res = await fetch('/api/accounts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        startUrl: this.addStartUrl,
                        region: this.addRegion
                    })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error);

                this.addFlow = data;

                // Open browser
                window.open(data.verificationUriComplete, '_blank');

                // Start polling
                this.addPollInterval = setInterval(() => this.pollAddAccount(), 3000);
            } catch (err) {
                this.showToast('error', err.message);
            }
        },

        async pollAddAccount() {
            if (!this.addFlow) return;
            try {
                const res = await fetch(`/api/accounts/${this.addFlow.flowId}/poll`);
                const data = await res.json();

                if (data.status === 'completed') {
                    clearInterval(this.addPollInterval);
                    this.addFlow = null;
                    this.showAddModal = false;
                    this.showToast('success', 'Account added successfully!');
                    await this.refresh();
                } else if (data.status === 'error') {
                    clearInterval(this.addPollInterval);
                    this.addFlow = null;
                    this.showToast('error', data.error);
                }
            } catch (err) {
                // Keep polling
            }
        },

        cancelAddFlow() {
            if (this.addPollInterval) clearInterval(this.addPollInterval);
            this.addFlow = null;
        },

        // Settings actions
        async applyClaudeConfig() {
            try {
                const res = await fetch('/api/claude-config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'apply' })
                });
                const data = await res.json();
                if (data.success) {
                    this.showToast('success', 'Claude Code configured! Restart Claude Code to apply.');
                    await this.fetchSettings();
                    await this.refresh();
                } else {
                    this.showToast('error', data.error);
                }
            } catch (err) {
                this.showToast('error', err.message);
            }
        },

        async removeClaudeConfig() {
            try {
                await fetch('/api/claude-config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'remove' })
                });
                this.showToast('success', 'Proxy config removed from Claude Code');
                await this.fetchSettings();
                await this.refresh();
            } catch (err) {
                this.showToast('error', err.message);
            }
        },

        async changeStrategy() {
            try {
                const res = await fetch('/api/strategy', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ strategy: this.selectedStrategy })
                });
                const data = await res.json();
                if (res.ok) {
                    this.showToast('success', `Strategy changed to ${data.label}`);
                    await this.refresh();
                } else {
                    this.showToast('error', data.error);
                }
            } catch (err) {
                this.showToast('error', err.message);
            }
        },

        showToast(type, message) {
            this.toast = { type, message };
            setTimeout(() => { this.toast = null; }, 3000);
        }
    };
}
