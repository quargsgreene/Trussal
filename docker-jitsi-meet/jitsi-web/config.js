[s6-init] making user provided files available at /var/run/s6/etc...exited 0.
[s6-init] ensuring user provided files have correct perms...exited 0.
[fix-attrs.d] applying ownership & permissions fixes...
[fix-attrs.d] done.
[cont-init.d] executing container initialization scripts...
[cont-init.d] 01-set-timezone: executing... 
[cont-init.d] 01-set-timezone: exited 0.
[cont-init.d] 10-config: executing... 
generating self-signed keys in /config/keys, you can replace these with your own keys if required
Using Nginx resolver: =172.31.0.2=
[cont-init.d] 10-config: exited 0.
[cont-init.d] done.
[services.d] starting services
[services.d] done.
[cmd] cat exited 1
[cont-finish.d] executing container finish scripts...
[cont-finish.d] done.
[s6-finish] waiting for services.
[s6-finish] sending all processes the TERM signal.
[s6-finish] sending all processes the KILL signal and exiting.
