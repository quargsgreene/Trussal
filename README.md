### Authors
---
| Name | Email |
| :--- | :--- |
| Quargs Greene | quargsgreene@gmail.com, qgreene@bu.edu |

# Trussal - A Networked Algorave Platform

## 1. Introduction
Where did the name "Trussal" come from?

This term is a combination of parts of the words "**truss**" and "**algorave**". According to the Merriam-Webster dictionary, the word "**truss**" can be defined as either a verb, which means to "support, strengthen, or stiffen by or as if by a truss", or as a noun, meaning "an assemblage of members (such as beams) forming a rigid framework" [1]. Trusses are very commonly found on concert stages of all kinds and they form the main structure holding many parts of the stage together, such as lights, speakers, and more.

Algoraves, on the other hand, are live musical performances, characterized by "sounds wholly or predominantly characterised by the emission of a succession of repetitive conditionals", as defined on algorave.com. Additionally, this website's "About" page goes on to describe an initiative to break down what proponents call "artificial barriers between the people creating the software algorithms and the people making the music. Using systems built for creating algorithmic music and visuals, such as IXI Lang, puredata, Max/MSP, SuperCollider, Extempore, Fluxus, TidalCycles, Gibber, Sonic Pi, FoxDot and Cyril" [2].

Trussal brings together the two concepts via the notion of software that serves as the structure of a stage for online algorithmically-driven musical co-creation and multimedia artistic interaction.

---
## 2. Project Mission

Trussal is a live multimedia concert platform. With a focus on and inspiration drawn the Algorave subculture, Trussal provides additional avenues alongside mainstream venues for engaging with live concerts. The solution is extending distributed web-based audiovisual software infrastructure to provide more ways for artists and audiences to coexist regardless of where they may be physically located and what they bring to the table.

---
## 3. Users

| Persona | Role & Responsibilities | Goals | How This Project Helps |
| :--- | :--- | :--- | :--- |
| **Live Coders** | Implement code in real time in a language, such as Strudel, or SuperCollider for the purpose of multimedia art creation | Provide a seamless performance, with a running in-browser program quickly updating and generating part or all of at least one artistic medium | Expands possibilities for audience participation, live remote collaboration, and custom algorithmic integration |
| **Musical Artists** | Perform musical works, whether preexisting or improvised in order to engage a live audience either alone or alongside other musicians | Deliver polished live audio and a satisfying communal listening experience | Reduces networked audio latency in ensemble contexts and facilitates a broad sense of social cohesion experienced in in-person performance settings |
| **Concertgoers** | Attend live concerts and partake in shared enjoyment with fellow concertgoers | Experiencing and inviting a sense of community and deriving pleasure listening to music for an afforable price | Provide an accessible interactive concert experience in remote and hybrid settings |
| **Live Sound Engineer** | Dynamically adjusting audio-related parameters, such as frequency response and volume, from front of house, to optimize live musical performances | Quickly manipulating incoming audio from a console based on listening to performers and helping set up backline | Provides real-time audio customization and monitoring |
| **Live Sound Engineer** | Dynamically adjusting audio-related parameters, such as frequency response and volume, from front of house, to optimize live musical performances | Quickly manipulating incoming audio from a console based on listening to performers and helping set up backline | Provides real-time audio customization and monitoring |
---
**In short:**

Trussal is for those seeking alternative venues and supplementation within traditional concert environments inspired by the Algorave ethos, as outlined by the corresponding set of general guidelines, with or without a prior software or electronic music background.

---

## 4. User Stories
Here are some user stories pertinent to each user category:

* Live Coders
    * *As a live coder, I should be able to collaborate in real-time with the audience and other performers using in-browser code editors that mutually exchange data without sacrificing performance, while hosting an Algorave.*
    * *As a live coder, I need the option of removing disruptive audience members from the show and explaining why they have been removed.*
    * *As a live coder, I need the option of hosting an event in full accordance with the Algorave code of conduct and Algorave core principles.*
    * *As a live coder, I would like to be able to sandbox different music-oriented programming languages of my choosing, and switch editors on the fly.*
* Musical Artists
    * *As an artist, I need to be able to collaborate with many other performers in remote locations without a perceptable delay*
    * *As a musical artist, I need to get an idea of what my audience hears and sees while I sound check and relay any needed information to my sound engineer.*
    * *As a musical artist, I would like multiple ways to interact with my audience and other performers during a show.*
    * *As an artist, I would like to be able to translate a stage plot to an online equivalent.*
    * *As a musical artist, I should be able to see how many people are watching.*
    * *As a musical artist, I need to be able to run my backline directly into the platform.*
    * *As an artist, I would like a smooth compensation experience when merch or tickets are purchased, via a pay-what-you-can model.*
    * *As an artist, it should be easy to highlight collaborations, along with any accompanying show dates and other events.*
* Concertgoers
    * *As an audience member, I want to be able to listen to and watch someone perform without a noticeably choppy live stream.*
    * *As a concertgoer, I must able to interact with the shared emotions of the performance and other audience members and have multiple options for doing so following the principles of universal design without feeling isolated.*
    * *As a concertgoer, I should be able to book tickets at a reasonable price, easily secure a ticket refund if I experience a sudden health issue the day of the show, and not worry about scarcity of seats.*
    * *As a concertgoer, I need to be able to watch a show without flashing lights if I so choose.*
    * *As a concertgoer, I need to be able to dynamically adjust the amount of data received via each sensory modality relevant to the show.*
    * *As a concertgoer, I’d like the ability to turn on live captioning if needed.*
* Production Staff
    * *As a live sound engineer, I need to be able to adjust parameters such as EQ and volume for each performer during a performance in real time.*
    * *As a live sound engineer, I need to be able to simulate and monitor a front-of-house experience on a variety of user devices*
    * *As a lighting technician, I need to be able to calibrate the live stream display remotely in real-time.*
    * *As a stage manager, I need to be able to remotely assist transitions between performers.*
---
## 5. Minimum Viable Product User Stories
For the minimum viable product, the performers and audience are focused on before production staff. Furthermore,

* Live Coders
    * *As a live coder, I should be able to collaborate in real-time with the audience and other performers using in-browser code editors that mutually exchange data without sacrificing performance, while hosting an Algorave.*
* Musical Artists
    * *As a musical artist, I need to be able to run my backline directly into the platform.*
    * *As a musical artist, I need to get an idea of what my audience hears and sees, and react to it.*
    * *As a musical artist, I need to be able to collaborate with many other performers in remote locations without perceptable delay.*
    * *As a musical artist, I should be able to see how many people are watching.*
* Concertgoers
    * *As a concertgoer, I must able to interact with the shared emotions of the performance and other audience members.*
    * *As a concertgoer, I should be able to easily book tickets.*
---
## 6. Summary of Research
Psychoacoustically, although it has been demonstrated that humans can compensate in a musical ensemble setting with latencies as high as 40ms, a perceivable audiovisual lag is noticeable with as little as 20ms delay, and human perception poses a multitude of fine-grained idiosyncrasies to contend with [3][4][5]. Furthermore, when musician feedback regarding metrics devised by Jack et al., such as "control intimacy" and "instrument transparency" was obtained across six quality metrics accounting for the presence of jitter, it was concluded that the acceptable predictable latency of digital live instrumental performance ought not to exceed 10ms [3].

The following obstacles are currently paramount in hindering widespread adopting of online, real-time, collaborative musical performance platforms:
* Real-time audio streaming at a sample rate of 48kHz (the professional film audio standard) and a bit depth of 24-bits (which allows a safe volume ceiling of 144Db, rather than 96Db at 16 bits) with an end-to-end latency of under 20ms lies beyond the capabilities of Opus, the audio codec of choice within WebRTC. WebRTC in general sets a standard of achieving sub 500ms latency, which is far more acceptable in speech-based applications such as teleconferencing than live musical collaboration [6][7].
* There is a widespread lack of web browser compatibility for uncompressed audio, as it is currently not included in the RTCPeerConnection API [8].
* Multiple factors contribute to latency accumulated, which stem from sources such as running algorithms, choice of hardware, and the physics of light and sound travel, causing latency to rapidly accumulate over long distances, even under ideal network conditions [9].
* Making use of existing progress in this area, such as LoLa, currently either requires access to expensive, difficult-to-scale, specialized hardware and network setup, or offers limited multimedia application, such as in the case of JackTrip [10][11].
* There is always some degree of tradeoff between fixed latency and the use of de-jitter buffers, and jitter must be dynamically estimated [8].
* Additionally, existing HMD camera hardware implementing NMP XR applications introduces a bottleneck in the form of client-size recorded frame rate [12].

The above issues imply not only ample opportunity to focus on achieving imperceptible levels of audiovisual latency at scale, but also the necessity of exploring not only the implementation of non-standard codecs on specialized dedicated client-side software systems, but also that of novel applications of edge computing and generative machine learning techniques in order to overcome the hurdles posed by physical distance and compensate for frequently inevitable data quality degradation, by respectively bringing computations closer to the user, as well as predicting and imputing lost data.

Typical live coding practices also pose unique challenges, such as the coupling between audio synthesis and instantaneous code execution in server-side synthesis (SSS), blurring of social boundaries between audience and performers, and the sharp waveforms characteristic of electronic music genres, and applications such as networked live coding as a whole, remain relatively unexplored [12][2].

Jin et al. have demonstrated the promise of a diffusion model approach in their implementation of *Audio Super Resolution (ASR)* within video conferencing applications including in music and film applications, and Verma et al. pioneered low-latency packet loss concealment via CNN architecture [13][14]. Rexford shows the viability of mitigating the inherent latency introduced by large physical distances and centralized cloud architectures via *Scallop*, a selective forwarding unit (SFU) implemented on top of WebRTC using the tenets of software-designed networking (SDN) [15] and Briscoe et al. propose the Low Latency, Low Loss, and Scalable Throughput (L4S) internet service architecture for achieving the required performance benchmarks [16].

Therefore, the task will be to design an application-specialized non-standard neural audio codec alongside corresponding adaptive SFU-friendly container orchestration on the backend, before implementing a client-side interface that accepts performance audiovisual input and delivers it to audiences.

---
## 7. Sprint 2 Goals
Sprint 2 will focus on the following:
* Identifying and gaining comfort with the benchmarking techniques and performance metrics that will document and verify the performance of the systems to be implemented.
* Finalizing the preexisting technologies to be used (e.g WebRTC with Insertable Streams, Pion, Janus, or Kurento as the primary server solution), as well as gathering and visualizing data to support these decisions.
* Identifying relevant sources of training data, how these datasets will be pre-processed.
* Diagramming a system architecture demonstrating the interaction between all of the backend system subcomponents as microservices.
* Determining and running the equivalent of a "Hello World" example on each of the chosen system pipeline components in disjunction.
* Figuring out which preexisting proprietary solutions, such as remote hardware acceleration for the purposes of server-side synthesis (SSS), will be needed, and estimating their respective monetary costs [17].
---
## 8. References
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
