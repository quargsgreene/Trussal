# Trussal - A Networked Algorave Platform

## 1. About
  The name "Trussal" is a combination of parts of the words "truss" and "algorave", and brings together 
  the two concepts with software that provides a stage for online, real-time algorithmically-driven 
  musical co-creation and multimedia artistic interaction, providing an alternative to strictly in-person venues. 
  JPattern, Trussal Studio,[!Jitsi Meet](https://jitsi.org/about/), [!Puppeteer](https://pptr.dev/guides/what-is-puppeteer), and [!Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API) and <a>MediaPipe</a> form the backbone for a hands-optional distributed live coding environment 
  inside of a video conferencing system. JPattern is a superset of the [!Strudel](https://strudel.cc/workshop/getting-started/) and [!Hydra](https://hydra.ojack.xyz/api/) pattern languages, born out of Trussal's prototyping journey, and additionally enables one to live code with text, 
  gestures, meeting reactions, participant polls, CSS, global meeting settings, and multimedia live 
  capture patterns, while able to modulate numerous parameters using different network metrics. 
  Trussal Studio houses the JPattern editors in addition to the status of the network, also serving as the interface for 
  calling upon bots to accompany oneself based on direct mutations of one's original pattern(s). 
  Trussal began with Quargs Greene in 2025 during master's work initially funded by Boston University.

## 2. Summary of Research
Psychoacoustically, although it has been demonstrated that humans can compensate in a musical ensemble setting with latencies as high as 40ms, a perceivable audiovisual lag is noticeable with as little as 20ms delay, and human perception poses a multitude of fine-grained idiosyncrasies to contend with [3][4][5]. Furthermore, when musician feedback regarding metrics devised by Jack et al., such as "control intimacy" and "instrument transparency" was obtained across six quality metrics accounting for the presence of jitter, it was concluded that the acceptable predictable latency of digital live instrumental performance ought not to exceed 10ms [3].

The following obstacles are currently paramount in hindering widespread adopting of online, real-time, collaborative musical performance platforms:
* Real-time audio streaming at a sample rate of 48kHz (the professional film audio standard) and a bit depth of 24-bits (which allows a safe volume ceiling of 144Db, rather than 96Db at 16 bits) with an end-to-end latency of under 20ms lies beyond the capabilities of Opus, the audio codec of choice within WebRTC. WebRTC in general sets a standard of achieving sub 500ms latency, which is far more acceptable in speech-based applications such as teleconferencing than live musical collaboration [6][7].
* There is a widespread lack of web browser compatibility for uncompressed audio, as it is currently not included in the RTCPeerConnection API [8].
* Multiple factors contribute to latency accumulated, which stem from sources such as running algorithms, choice of hardware, and the physics of light and sound travel, causing latency to rapidly accumulate over long distances, even under ideal network conditions [9].
* Making use of existing progress in this area, such as LoLa, currently either requires access to expensive, difficult-to-scale, specialized hardware and network setup, or offers limited multimedia application, such as in the case of JackTrip [10][11].
* There is always some degree of tradeoff between fixed latency and the use of de-jitter buffers, and jitter must be dynamically estimated [8].
* Additionally, existing HMD camera hardware implementing NMP XR applications introduces a bottleneck in the form of client-side recorded frame rate [12].

Typical live coding practices also pose unique challenges, such as the coupling between audio synthesis and instantaneous code execution in server-side synthesis (SSS), blurring of social boundaries between audience and performers, and the sharp waveforms characteristic of electronic music genres, and applications such as networked live coding as a whole, remain relatively unexplored [12][2].

Jin et al. have demonstrated the promise of a diffusion model approach in their implementation of *Audio Super Resolution (ASR)* within video conferencing applications including in music and film applications, and Verma et al. pioneered low-latency packet loss concealment via CNN architecture [13][14]. Rexford shows the viability of mitigating the inherent latency introduced by large physical distances and centralized cloud architectures via *Scallop*, a selective forwarding unit (SFU) implemented on top of WebRTC using the tenets of software-designed networking (SDN) [15] and Briscoe et al. propose the Low Latency, Low Loss, and Scalable Throughput (L4S) internet service architecture for achieving the required performance benchmarks [16].

## 3. References
* [1] "Definition of TRUSS," *Merriam-Webster.com Dictionary*. [Online]. Available: https://www.merriam-webster.com/dictionary/truss. (Accessed: Oct. 6, 2025).
* [2] "About," Algorave.com. [Online]. Available: https://algorave.com/. (Accessed: Oct. 6, 2025).
* [3] R. H. Jack, T. Stockman, and A. McPherson, "Effect of latency on performer interaction and subjective quality assessment of a digital musical instrument," in *Proc. 2016 Int. Conf. New Interfaces for Musical Expression (NIME)*, Brisbane, QLD, Australia, Jul. 11–14, 2016, pp. 248–253. doi: 10.1145/2986416.2986423.
* [4] H. Lara, L. H., and V. Luka, "White paper Embodiment in Extended Reality: Concepts, Challenges and Future Directions," IMMSERSIVE LAB. (Accessed: Oct. 6, 2025). [Online]. Available: https://www.ap.be/sites/default/files/users/user7450/White%20paper%20Embodiment%20in%20XR_25.06.2025.pdf.
* [5] G. Santini, "A Case Study in XR Live Performance," in *Proc. 2024 Int. Conf. on New Interfaces for Musical Expression (NIME)*, L. N. C. Science, Ed. Cham: Springer Nature Switzerland, 2024, pp. 286–300. doi: 10.1007/978-3-031-71710-9_22.
* [6] "OpusFAQ," XiphWiki. [Online]. Available: https://wiki.xiph.org/OpusFAQ. (Accessed: Oct. 6, 2025).
* [7] "WebRTC Home," Webrtc.org. [Online]. Available: https://webrtc.org/. (Accessed: Oct. 6, 2025).
* [8] C. Sacchetto, M. Gastaldi, P. Chafe, C. Rottondi, and C. Servetti, "Web-Based Networked Music Performances via WebRTC: A Low-Latency PCM Audio Solution," *J. Audio Eng. Soc.*, vol. 68, no. 11, pp. 832–844, Nov. 2020. doi: 10.17743/jaes.2020.0016.
* [9] "How Latency Makes Jamming Together in Real Time Nearly Impossible," NGINX Community Blog, Oct. 9, 2020. [Online]. Available: https://blog.nginx.org/blog/how-latency-makes-jamming-together-in-real-time-nearly-impossible. (Accessed: Oct. 6, 2025).
* [10] "LoLa," Consorzio Top-IX. [Online]. Available: https://lola.conts.it/. (Accessed: Oct. 6, 2025).
* [11] "Make Music Together Online," JackTrip Labs. [Online]. Available: https://www.jacktrip.com/. (Accessed: Oct. 6, 2025).
* [12] S. Lee and G. Essl, "Models and Opportunities for Networked Live Coding," in *Proc. 2014 Int. Conf. on Live Coding (ICLC)*, Leeds, U.K., Jul. 2014, pp. 111–118. [Online]. Available: https://echolab.cs.vt.edu/wp-content/uploads/sites/105/2024/05/LCCS14-NetworkedCollaborationLiveCoding-26ryb6m.pdf.
* [13] Y. Jin, J. Lin, J. Liu, A. Liu, P. Chen, S. Ma, T. Chen, and K. Chen, "Inference-time Scaling for Diffusion-based Audio Super-resolution," 2025. [Online]. Available: https://arxiv.org/pdf/2508.02391.
* [14] P. Verma, A. I. Mezza, C. Chafe, and C. Rottondi, "A Deep Learning Approach for Low-Latency Packet Loss Concealment of Audio Signals in Networked Music Performance Applications," in *Proc. 2020 Int. Conf. on Communications, Computing, and Digital Production (FRUCT)*, Moscow, Russia, Sep. 10–12, 2020, pp. 299–304. doi: 10.23919/fruct49677.2020.9210988.
* [15] O. Michel, P. Rexford, C. Santini, and L. Turchet, "Scalable Video Conferencing Using SDN Principles," 2025. [Online]. Available: https://arxiv.org/pdf/2503.11649.
* [16] B. Briscoe, O. Bondarenko, K. De Schepper, and I. Tsang, "L4S: Ultra-Low Queuing Delay for All," in *Proc. 2017 Global Internet Symposium (GI)*, Jun. 2017, pp. 1–6.
* [17] "Hardware Accelerators Raise the Ceiling for Edge Servers," VDC Research, 2025. [Online]. Available: https://www.vdcresearch.com/News-events/iot-blog/24-Hardware-Accelerators-Raise-the-Ceiling-for-Edge-Servers.html. (Accessed: Oct. 6, 2025).
* [18] L. Turchet, N. Garau, and N. Conci, "Networked Musical XR: where’s the limit? A preliminary investigation on the joint use of point clouds and low-latency audio communication," in *Proc. 2022 AudioMostly (AM)*, Sep. 2022, pp. 226–230. doi: 10.1145/3561212.3561237.
* [19] A. Schmeder, A. Freed, and D. Wessel, "Best Practices for Open Sound Control," *Open Sound Control*. [Online]. Available: https://opensoundcontrol.stanford.edu/files/osc-best-practices-final.pdf.
