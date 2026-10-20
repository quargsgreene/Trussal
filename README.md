# Trussal - A Networked Algorave Platform
## 1. About
  The name "Trussal" is a combination of parts of the words "truss" and "algorave", and brings together 
  the two concepts with software that provides a stage for online, real-time algorithmically-driven 
  musical co-creation and multimedia artistic interaction, providing an alternative to strictly in-person venues. 
  JPattern, Trussal Studio, [Jitsi Meet](https://jitsi.org/about/), [Puppeteer](https://pptr.dev/guides/what-is-puppeteer), and [Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API) and [MediaPipe](https://developers.google.com/edge/mediapipe/solutions/guide) form the backbone for a hands-optional distributed live coding environment inside of a video conferencing system. JPattern is a superset of the [Strudel](https://strudel.cc/workshop/getting-started/) and [Hydra](https://hydra.ojack.xyz/api/) pattern languages, born out of Trussal's prototyping journey, and additionally enables one to live code with text, 
  gestures, meeting reactions, participant polls, CSS, global meeting settings, and multimedia live 
  capture patterns, while able to modulate numerous parameters using different network metrics. 
  Trussal Studio houses the JPattern editors in addition to the status of the network, also serving as the interface for calling upon bots to accompany oneself based on direct mutations of one's original pattern(s). 
  Trussal began with Quargs Greene in 2025 during master's work initially funded by Boston University.
  
<p align="center" width="100%">
    <img width="50%" alt="Punchcards" src="https://github.com/user-attachments/assets/7286def9-14c3-4258-a572-1bc89ea883e3"/>
</p>  
<p align="center" width="100%">
    <img width="50%" alt="ReactionPattern" src="https://github.com/user-attachments/assets/21e81630-8bc5-46bd-98c5-e450459a4244"/>
</p> 
<p align="center" width="100%">
    <img width="50%" alt="Triadic Hydra Oscs" src="https://github.com/user-attachments/assets/f8eb742e-de5e-40c5-a06a-18852ae730c4"/>
</p>
<p align="center">Top: 12 human participants, Middle: 1 human participant, Bottom: Bots creating a Hydra metapattern</p>

## 2. Documentation
Documentation can be found [here](https://trussal.com).

## 3. Running locally
Clone the repository and install the dependencies. You also need Docker installed. Then run `npm run dev:setup` to build the application. Then run `npm run dev` and navigate to one of the specified URLs in your browser of choice. You should be able to see updates in your browser for most of the application upon saving the corresponding modified file(s). If not, stop the dev server and rebuild. If a port remains stuck in use, try running `npm run dev:down` before further troubleshooting.

## 4. Hosting your own Trussal instance
You may host your own Trussal instance by modifying site configuration files to point at your own domain and this works much the same way as it does with Jitsi Meet as a whole. See the [!Self-Hosting Guide](https://jitsi.github.io/handbook/docs/devops-guide/) in the Jitsi Meet Handbook for more information.
