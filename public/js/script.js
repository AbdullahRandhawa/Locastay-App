// Bootstrap validation
(() => {
  'use strict'
  const forms = document.querySelectorAll('.needs-validation')
  Array.from(forms).forEach(form => {
    form.addEventListener('submit', event => {
      if (!form.checkValidity()) { event.preventDefault(); event.stopPropagation(); }
      form.classList.add('was-validated')
    }, false)
  })
})();

// Dark Mode Toggle
(function () {
  const HTML = document.documentElement;
  const KEY  = 'rentlyst-theme';

  function applyTheme(dark) {
    const icons = document.querySelectorAll('.dark-mode-icon');
    if (dark) {
      HTML.setAttribute('data-theme', 'dark');
      localStorage.setItem(KEY, 'dark');
      icons.forEach(icon => icon.className = 'fa-solid fa-sun dark-mode-icon');
    } else {
      HTML.removeAttribute('data-theme');
      localStorage.setItem(KEY, 'light');
      icons.forEach(icon => icon.className = 'fa-solid fa-moon dark-mode-icon');
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    // Default is dark unless user explicitly chose light
    const saved = localStorage.getItem(KEY);
    const isDark = saved !== 'light'; // dark unless explicitly set to light
    applyTheme(isDark);

    const btns = document.querySelectorAll('.dark-mode-toggle');
    btns.forEach(btn => {
      btn.addEventListener('click', function () {
        applyTheme(HTML.getAttribute('data-theme') !== 'dark');
      });
    });
  });
})();