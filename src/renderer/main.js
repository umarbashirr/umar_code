// Single entry. React renders the shell; everything else is loaded after that,
// because the modules below still find their nodes with querySelector and those
// nodes do not exist until the shell has committed.
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import './ui/main.jsx';
