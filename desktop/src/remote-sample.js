const agent = new URLSearchParams(location.search).get('agent') || 'intelio';
window.IntelioRemote.mountSample({ agent });
