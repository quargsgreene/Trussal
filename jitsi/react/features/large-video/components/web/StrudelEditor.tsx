import React, { Component } from 'react';
import { createPortal } from 'react-dom';
/**
 * Component that loads and displays the Strudel editor.
 */
interface IState {
    isInitialized: boolean;
}

class StrudelEditor extends Component<Record<string, never>, IState> {
    private containerRef: React.RefObject<HTMLDivElement>;
    private portalRoot: HTMLDivElement;

    constructor(props: Record<string, never>) {
        super(props);
        this.containerRef = React.createRef<HTMLDivElement>();
        this.state = {
            isInitialized: false
        };
        this.portalRoot = document.createElement('div');
        this.portalRoot.setAttribute('id', 'strudel-editor-portal');
    }

   override componentWillUnmount() {
        document.body.removeChild(this.portalRoot);
    }

    /**
     * Initializes the Strudel editor after the script loads.
     */
    private initializeStrudel = () => {
        console.log('StrudelEditor: Initializing Strudel...');

            // Initialize Strudel editor - FOCUS ON THE REPL METHOD
            try {
                const Strudel = (window as any).Strudel || (window as any).strudel;
                const container = this.containerRef.current;
                

                if (Strudel && Strudel.repl && typeof Strudel.repl === 'function') {
                    const repl = Strudel.repl({ target: container });
                    this.setState({ isInitialized: true });
                    console.log('StrudelEditor: Successfully initialized Strudel REPL:', repl);
                    
                    // CRITICAL: Force a layout refresh for the editor
                    // Strudel's REPL instance might have a .refresh() or .layout() method
                    if ((repl as any).refresh && typeof (repl as any).refresh === 'function') {
                        (repl as any).refresh();
                        console.log('StrudelEditor: Called repl.refresh()');
                    }
                    if ((repl as any).layout && typeof (repl as any).layout === 'function') {
                        (repl as any).layout();
                        console.log('StrudelEditor: Called repl.layout()');
                    }
                    // A simple window resize event can also sometimes trigger the editor to redraw
                    window.dispatchEvent(new Event('resize'));
                }
            } catch (initError) {
                // **CRITICAL:** This error log will capture what's failing now
                console.error('StrudelEditor: Error during final initialization attempt. Check this error:', initError);
            }



        try {
            const container = this.containerRef.current;
            if (!container) {
                console.warn('StrudelEditor: Container ref is not available');
                return;
            }

            // Check if Strudel is available (try both capital and lowercase)
            const Strudel = (window as any).Strudel || (window as any).strudel;
            if (!Strudel) {
                console.warn('StrudelEditor: Strudel is not available on window object');
                return;
            }

            console.log('StrudelEditor: Initializing Strudel...', Strudel);

            // Initialize Strudel editor - try different possible APIs
            try {
                if (Strudel.repl && typeof Strudel.repl === 'function') {
                    const repl = Strudel.repl({ target: container });
                    this.setState({ isInitialized: true });
                    console.log('StrudelEditor: Successfully initialized Strudel REPL');
                } else if (Strudel.init && typeof Strudel.init === 'function') {
                    Strudel.init(container);
                    this.setState({ isInitialized: true });
                    console.log('StrudelEditor: Successfully initialized Strudel');
                } else if (typeof Strudel === 'function') {
                    new Strudel(container);
                    this.setState({ isInitialized: true });
                    console.log('StrudelEditor: Successfully initialized Strudel');
                } else {
                    console.warn('StrudelEditor: Strudel API not recognized. Available methods:', Object.keys(Strudel || {}));
                    // Log the Strudel object structure for debugging
                    console.log('StrudelEditor: Full Strudel object:', Strudel);
                }
            } catch (initError) {
                console.error('StrudelEditor: Error during initialization:', initError);
            }
        } catch (error) {
            console.error('StrudelEditor: Error initializing Strudel editor:', error);
        }
    };

    /**
     * Loads the Strudel script and initializes the editor.
     */
   override componentDidMount() {
        try {
            document.body.appendChild(this.portalRoot);
            // Ensure we're in a browser environment
            if (typeof document === 'undefined' || !document.body) {
                return;
            }

            // Check if script is already loaded
            const existingScript = document.querySelector('script[src*="strudel"]');
            if (existingScript) {
                // Script already loaded, try to initialize with retries
                let attempts = 0;
                const tryInit = () => {
                    attempts++;
                    if (typeof (window as any).Strudel !== 'undefined' || typeof (window as any).strudel !== 'undefined') {
                        this.initializeStrudel();
                    } else if (attempts < 10) {
                        setTimeout(tryInit, 200);
                    }
                };
                tryInit();
                return;
            }

            const iframe = document.createElement('iframe');
            iframe.src = "https://strudel.cc/?xwWRfuCE8TAR";
            iframe.width = '100%';
            iframe.height = '30%';
            iframe.onload = () => {
                console.log('StrudelEditor: Script loaded, waiting for Strudel to be available...');
                // Wait a bit for Strudel to be available on window
                // Check multiple times as Strudel may load asynchronously
                let attempts = 0;
                const checkStrudel = () => {
                    attempts++;
                    if (typeof (window as any).Strudel !== 'undefined' || typeof (window as any).strudel !== 'undefined') {
                        this.initializeStrudel();
                    } else if (attempts < 20) {
                        setTimeout(checkStrudel, 100);
                    } else {
                        console.warn('StrudelEditor: Strudel did not become available after script load');
                    }
                };
                checkStrudel();
            };
            iframe.onerror = () => {
                console.error('Failed to load Strudel script');
            };
            
            document.body.appendChild(iframe);
        } catch (error) {
            console.error('Error loading Strudel editor:', error);
        }
    }

    /**
     * Renders the component.
     *
     * @returns {ReactElement}
     */
    override render() {
        return (            
        <iframe
            src="https://strudel.cc/?xwWRfuCE8TAR"
            width="100%"
            height="30%"
            style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                width: '100%',
                height: '30%',
                zIndex: 5,
                pointerEvents: 'auto',
                backgroundColor: 'black',
                overflow: 'visible'
            }}
        />);
    }
}

export default StrudelEditor;

