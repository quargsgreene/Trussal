## Authors
---
| Name | Email |
|---|---|
| Quargs Greene | quargsgreene@gmail.com, qgreene@bu.edu |

# Trussal

## 1.  Project Mission

Trussal is a live multimedia concert platform. With a focus on the Algorave subculture, Trussal provides additional avenues for engaging with live concerts.

---

## 2. Users

| Persona                         | Role & Responsibilities                                                                 | Goals                                                                                      | How This Project Helps                                                                     |
|--------------------------------|------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------|
| **Live Coders** | Implement code in real time in a language, such as Strudel, for the purpose of multimedia art creation | Provide a seamless performance, with a running in-browser program quickly updating and generating part or all of at least one artistic medium | Expands possibilities for audience participation, live remote collaboration, and custom algorithmic integration |
| **Musical Artists** | Perform musical works, whether preexisting or improvised in order to engage a live audience either alone or alongside other musicians | Deliver polished live audio and a satisfying communal listening experience | Reduces networked audio latency in ensemble contexts and preserves the sense of social cohesion experiened in in-person performance settings |
| **Concertgoers**  | Attend live concerts and partake in shared enjoyment with fellow concertgoers | Experiencing a sense of community and deriving pleasure listening to music for an afforable price | Provides an acessible interactive concert experience in remote and hybrid settings |
| **Live Sound Engineer**  | Dynamically adjustng audio-related parameters, such as frequency response and volume, from front of house, to optimize live musical performances | Quickly manipulating incoming audio from a console based on listening to performers and helping set up backline | Provides real-time audio customization and monitoring |
---
**In short:**  
Trussal is for those seeking alternative venus and supplementation within traditional concert environments inspired by the Algorave ethos, with or without a prior software or electronic music background.

## 3. User Stories

Here are some user stories pertinent to each user category:

* Live Coders
    * *As a live coder, I should be able to collaborate in real-time with the audience and other performers using in-browser code editors that mutually exchange data without sacrificing performance, while hosting an Algorave.* 
    * *As a live coder, I need the option of removing disruptive audience members from the show and explaining why they have been removed.* 
    * *As a live coder, I need the option of hosting an event in full accordance with the Algorave code of conduct and Algorave core principles.*
* Musical Artists
    * *As a musical artist, I need to get an idea of what my audience hears and sees while I sound check and relay any needed information to my sound engineer.*
    * *As a musical artist, I would like multiple ways to interact with my audience and other performers during a show.*
    * *As an artist, I would like to be able to translate a stage plot to an online equivalent.*
    * *As an artist, I need to be able to collaborate with many other performers in remote locations*
    * *As a musical artist, I should be able to see how many people are watching.*
    * *As a musical artist, I need to be able to run my backline directly into the platform.*
* Concertgoers
    * *As a concertgoer, I must able to interact with the shared emotions of the performance and other audience members and have multiple options for doing so following the principles of universal design without feeling isolated.*
    * *As a concertgoer, I should be able to book tickets at a reasonable price,  easily secure a ticket refund if I experience a sudden health issue the day of the show, and not worry about scarcity of seats.*
    * *As a concertgoer, I need to be able to watch a show without flashing lights if I so choose.*
    * *As a concertgoer, I need to be able to dynamically adjust the amount of data received via each sensory modality relevant to the show.*
    * *As a concertgoer, I’d like the ability to turn on live captioning if needed.*
* Live Sound Engineers
    * *As a live sound engineer, I need to be able to adjust parameters such as EQ and volume for each performer during a performance in real time.*
    * *As a live sound engineer, I need to be able to simulate and monitor a front-of-house experience on a variety of user devices*
## 4. Minimum Viable Product User Stories
* Live Coders
    * *As a live coder, I should be able to collaborate in real-time with the audience and other performers using in-browser code editors that mutually exchange data without sacrificing performance, while hosting an Algorave.* 
    * *As a musical artist, I need to get an idea of what my audience hears and sees, and react to it.*
    * *As a musical artist, I need to be able to collaborate with many other performers in remote locations.*
    * *As a musical artist, I should be able to see how many people are watching.*
* Concertgoers
    * *As a concertgoer, I must able to interact with the shared emotions of the performance and other audience members.*
    * *As a concertgoer, I should be able to easily book tickets.*
## 5. Summary of Research
Two particularly large obstacles in widespread adoption of online, real-time, collaborative musical platforms are: 1. Achieving sub 20ms rountrip audiovisual latency for the purposes o avoiding a perceptable amount of asynchrony and 2. The lack of immersive, interactive, co-creative online performing arts spaces that do not require specific, specialized, costly hardware and/or software purchases as a prerequisite for use and the provision of user feedback. Furthermore, there is a dearth of research and lack of the requisite audio codec standardization initiatives regarding posssible solutions to the aforementioned issues.

Currently, mechanisms for robust user feedback and user-based application parameter tuning in musical Web XR workloads are largely limited to the use of a rather heterogeneous set of head-mounted devices, and noisy neuroimaging systems such as EEG. Existing related platforms either individually address a subset of the pertinent issues at play, or focus on a non-musical application of audio (e.g. Zoom, Microsoft), such as speech.

There exist many parts of the network transmmission project, they will continue to make thlse surrounding[

]

The above issues imply that there is ample opportunity to focus on achieving imperceptible levels of audiovisual latency at scale by optimizing the transmission of video within a peer-to-peer network on the back end. Whether this will be accomplished merely by improving the algorithmic and physical performance of the audiovisual transmission process, or will ultimately require a suite of just-in-time imputation techniques via a machine learning model drawing from techniques such as reinforcement learning and graph neural network remains to be seen.

## 6. Sprint 2 Goals

Sprint 2 will focus on reducing backend audiovisual latency and investigating the suitability of multiple open source video conferencing tools for integration into a high-fidelity live audiovisual system for the web. This entails the pursuit of the following goals:
    * Identifying and comparing the capabilities different open-source P2P video servers, particularly when it comes to the suitability for audiovisual workloads with audio sample rates at or above 44.1kHz with a bit depth of 24 bits.
    * Choosing the P2P video server solution that will best suit the needs of the application
    * Developing a set of benchmarks that comprise a standard of minimum acceptable audiovisual fidelity and a way to measure their attainment
    * Understanding and starting to ameliorate the root causes technical infrastructural gaps that cause the latency issues hindering distributed remote multimedia musical collaboration and interaction, particularly with respect to each intended system component.

## 7. References
    * Networked Musical XR: where’s the limit? A preliminary investigation on the joint use of point clouds and low-latency audio communication (Turchet, et al.)
    * Issues and Challenges of Audio Technologies for the Musical Metaverse (Boem, et al.)
    * A Case Study in Live XR Performance (Santini)
    * Embodiment in Extended Reality: Concepts, Challenges and Future Directions (Lara, et al.)
    * Network Modeling using Graph Neural Networks (Galmés, 2024)
    * FairSIN: Achieving Fairness in Graph Neural Networks through Sensitive Information Neutralization (Yang, et al., 2024)
    * Neuroadaptive Haptics: Comparing Reinforcement Learning from Explicit Ratings and Neural Signals for Adaptive XR Systems (Gehrke, et al., 2025)
    * SIGMOD: U: Link Local Differential Privacy in GNNs via Bayesian Estimation (Xu, 2023)
