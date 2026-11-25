// Maison Resto - Common Utilities & Shared API Client

const Maison = {
  // Format Indonesian Rupiah
  formatRupiah(amount) {
    if (isNaN(amount) || amount === null) return 'Rp 0';
    return new Intl.NumberFormat('id-ID', {
      style: 'currency',
      currency: 'IDR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(amount);
  },

  // Format Date and Time
  formatDate(dateString) {
    if (!dateString) return '-';
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return dateString;
    return new Intl.DateTimeFormat('id-ID', {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    }).format(date);
  },

  formatDateTime(dateString) {
    if (!dateString) return '-';
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return dateString;
    return new Intl.DateTimeFormat('id-ID', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  },

  formatTime(dateString) {
    if (!dateString) return '-';
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return dateString;
    return new Intl.DateTimeFormat('id-ID', {
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  },

  // Toast Notification
  showToast(message, type = 'info') {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    let icon = '🔔';
    if (type === 'success') icon = '✓';
    if (type === 'error') icon = '✕';
    if (type === 'warning') icon = '⚠';

    toast.innerHTML = `
      <span style="font-size: 1.2rem;">${icon}</span>
      <div style="flex: 1;">${message}</div>
    `;

    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100%)';
      toast.style.transition = 'all 0.3s ease-out';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  },

  // Sound notification for new orders
  playChime() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.15); // A5
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.3);
    } catch (e) {
      // AudioContext might require user interaction first
    }
  },

  // API Client with automatic error and redirect handling
  async fetchApi(endpoint, options = {}) {
    const defaultHeaders = {
      'Content-Type': 'application/json'
    };

    const token = localStorage.getItem('maison_token');
    if (token) {
      defaultHeaders['Authorization'] = `Bearer ${token}`;
    }

    const config = {
      ...options,
      headers: {
        ...defaultHeaders,
        ...(options.headers || {})
      }
    };

    try {
      const response = await fetch(endpoint, config);
      const data = await response.json();

      if (!response.ok) {
        if (response.status === 401) {
          // Token expired or not authenticated
          const currentPath = window.location.pathname;
          if (currentPath.startsWith('/owner')) window.location.href = '/owner/login';
          else if (currentPath.startsWith('/kasir')) window.location.href = '/kasir/login';
          else if (currentPath.startsWith('/dapur')) window.location.href = '/dapur/login';
        }
        throw new Error(data.error || 'Terjadi kesalahan sistem');
      }

      return data;
    } catch (err) {
      console.error(`API Error on ${endpoint}:`, err);
      throw err;
    }
  },

  // Logout helper
  async logout(portal) {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch (e) {
      // ignore
    }
    localStorage.removeItem('maison_token');
    localStorage.removeItem('maison_user');

    if (portal === 'owner') window.location.href = '/owner/login';
    else if (portal === 'kasir') window.location.href = '/kasir/login';
    else if (portal === 'dapur') window.location.href = '/dapur/login';
    else window.location.href = '/';
  },

  // Check auth session on load
  async checkSession(allowedRoles = []) {
    try {
      const res = await fetch('/api/auth/me', {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('maison_token') || ''}`
        }
      });
      if (!res.ok) throw new Error('Not authenticated');
      const data = await res.json();
      const user = data.user;
      localStorage.setItem('maison_user', JSON.stringify(user));

      if (allowedRoles.length > 0 && !allowedRoles.includes(user.role)) {
        this.showToast('Akses tidak diizinkan untuk role Anda', 'error');
        if (user.role === 'owner') window.location.href = '/owner';
        else if (user.role === 'kasir') window.location.href = '/kasir';
        else if (user.role === 'dapur') window.location.href = '/dapur';
        return null;
      }

      return user;
    } catch (err) {
      const currentPath = window.location.pathname;
      if (currentPath.startsWith('/owner')) window.location.href = '/owner/login';
      else if (currentPath.startsWith('/kasir')) window.location.href = '/kasir/login';
      else if (currentPath.startsWith('/dapur')) window.location.href = '/dapur/login';
      return null;
    }
  }
};
