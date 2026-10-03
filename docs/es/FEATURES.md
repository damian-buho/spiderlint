<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: MIT
-->

<!-- textlint-disable terminology,common-misspellings -->

[English](../FEATURES.md) · [Українська](../uk/FEATURES.md)

# Características

## Características del proyecto

### Accesibilidad revisada desde todos los lados

- Cada regla de axe-core para WCAG 2.2 A y AA, y sus buenas prácticas, se ejecuta en la página renderizada, así que también se detectan los defectos que introducen los scripts.
- El marcado de cada página, no de una muestra, se revisa en busca de los defectos de accesibilidad que html-validate ve sin navegador: etiquetas que faltan, niveles de encabezado saltados, texto alternativo ausente.
- El uso con teclado se prueba en unas pocas páginas por plantilla: Tab debe alcanzar cada control sin quedar atrapado, el foco debe verse y no quedar tapado, un enlace para saltar al contenido debe ir primero, y se informa de los manejadores de clic en elementos simples.
- Se respetan los ajustes del visitante: las animaciones se detienen con movimiento reducido, el texto sigue legible en el esquema oscuro y en el contraste alto que ofrece la página, el foco y los iconos sobreviven al contraste alto de Windows, y los campos de formulario son lo bastante grandes para que los teléfonos no amplíen.

### Páginas renderizadas en el cliente, auditadas tal como las ven los visitantes

- Una página cuyas etiquetas, enlaces o contenido aparecen solo después de ejecutar sus scripts se renderiza en un navegador real, así que se revisa lo que ven los buscadores y los visitantes.
- Solo se renderizan las secciones que necesitan un navegador; el resto del sitio se rastrea por HTTP simple a toda velocidad en la misma ejecución, y una sección que renderiza sus etiquetas en el cliente se puede detectar sola.
- Los errores de consola, los tiempos de carga y cada recurso que una página carga en tiempo de ejecución se convierten en hechos que las reglas pueden comprobar.
- Se informa de lo que pierde una página sin JavaScript —su título, descripción, enlace canónico, encabezado, enlaces internos o texto—, comparando su HTML original con la página renderizada.

### CSS revisado como lo leen los navegadores

- Las hojas de estilo y el CSS en línea se analizan en busca de lo que los navegadores descartan sin avisar: errores de sintaxis que pierden una regla entera, propiedades mal escritas y valores fuera de la gramática de la propiedad.
- Cada defecto indica su línea y columna, en la hoja de estilo o en la página que contiene el bloque en línea.
- Una hoja de estilo que cargan todas las páginas es un solo hallazgo con las páginas que la usan, y el CSS en línea se agrupa por plantilla.
- Las características que no tienen los navegadores declarados por el proyecto se listan junto con esos navegadores, y el código dentro de `@supports` no se toca.
- Los prefijos de proveedor y los trucos para navegadores antiguos nunca se informan, y la revisión no necesita un validador en Java.

### El DNS detrás de cada host rastreado

- Se informa de la falta de registros HTTPS, para que una primera visita pueda empezar en HTTP/3 sin un viaje extra para descubrirlo.
- CAA se juzga contra el certificado que el sitio sirve de verdad, así que una CA que CAA prohíbe se detecta antes de que falle una renovación.
- DNSSEC se comprueba de extremo a extremo: una zona sin firmar, algoritmos débiles, firmas que ya no se renuevan y una zona firmada que los resolvedores con validación rechazan.
- Se pregunta directamente a los servidores de nombres y cualquier otra consulta va solo al resolvedor que indiques, así que un servidor cojo o una zona desincronizada salen a la luz, y un enlace a un subdominio cuyo CNAME no apunta a nada se marca como riesgo de secuestro.
- Cada nombre se juzga por lo que sus registros dicen que hace con el correo: al que no lo usa se le exige un MX nulo, un SPF que lo rechaza todo y una política DMARC de rechazo, y al que sí, un único registro SPF cerrado y una política DMARC aplicada, así que una configuración a medias sale a la luz en ambos casos.
- El registro del dominio se lee de su registro, así que una renovación a pocos días, un bloqueo de transferencia ausente o un registro que nombra otros servidores de nombres que la zona se ven antes de que el dominio caduque o se lo lleven.
- Cada dirección se atribuye a la red que la enruta, así que salen a la luz una ruta que las redes que aplican RPKI descartan, un servidor de correo sin DNS inverso que coincida, o un sitio y sus servidores de nombres detrás de un solo proveedor.
- Las huellas de claves de host SSH publicadas en el DNS se comparan con las claves que el servidor SSH presenta de verdad, así que un registro que quedó obsoleto tras rotar una clave se detecta antes de que los clientes se nieguen a conectar, y se señala el que ningún cliente puede creer sin DNSSEC.

### Feeds revisados tal como los ven los lectores

- Los feeds RSS, Atom y JSON se revisan según su propia especificación: campos obligatorios, fechas que los lectores puedan leer e identificadores que nunca se repiten ni cambian, para que nadie vea una entrada antigua como nueva.
- El contenido de cada entrada se lee como lo muestra un lector: Markdown o MDX sin convertir, marcadores de plantilla, enlaces e imágenes relativos, doble escapado y marcado que los lectores eliminan, cada uno con la entrada en la que aparece.
- Cada entrada se compara con la página a la que enlaza: un enlace que falla o redirige, un título, una fecha o un idioma que no coinciden, una URL canónica que el feed esquiva, y un feed de adelantos donde los lectores esperan artículos.
- También se juzga cómo se sirve el feed para su consulta periódica: su tipo y codificación, las peticiones condicionales hasta una revalidación respondida con 200 y un cuerpo sin cambios en vez de 304, la caché, el tamaño y una hoja XSL que Chrome ya no aplica.
- Los feeds de pódcast pueden revisarse, de forma opcional, en lo que exigen los directorios: las etiquetas de canal y de episodio de iTunes, un GUID estable de Podcasting 2.0, una política `podcast:locked` y una carátula que Apple acepta — JPEG o PNG cuadrado, de 1400 a 3000 px por lado.
- Cada adjunto se consulta una vez con HEAD y se juzga contra su declaración: alcance, coincidencia de bytes y de tipo, y soporte de rangos de bytes, que Apple exige a los servidores de episodios.
- Un hub WebSub declarado puede sondearse con una petición de descubrimiento, solo de forma opcional.
- Una muestra del corpus del validador de feeds del W3C viaja como fixtures, para que cada mensaje que él emite siga emitiéndose aquí.
- Un directorio de pódcast exige RSS 2.0 con los espacios de nombres de iTunes y de contenido declarados, un adjunto único con URL, longitud y tipo por episodio, un GUID por episodio que nunca cambia y fechas RFC 2822.

### Un hallazgo por plantilla, no por página

- Las páginas se agrupan por patrón de URL, así que un defecto que comparten todas las entradas se informa una sola vez para su plantilla, con páginas de ejemplo; las comprobaciones costosas, como la accesibilidad, se ejecutan solo en unas pocas páginas de cada plantilla.
- Un grupo cuyas páginas discrepan en una regla recibe un aviso de que probablemente mezcla dos plantillas.
- Los valores que deben ser únicos en todo el sitio, como títulos y descripciones, se informan una vez por duplicado con todas las URL que lo comparten.
- Cada ejecución termina con el número de comprobaciones superadas y una nota de la S a la F, para comparar sitios y versiones de un vistazo.

### Iconos descargados y medidos

- Cada icono que nombran las páginas, el manifiesto de la aplicación web y `browserconfig.xml` se descarga una vez y se mide, así que un icono realmente más pequeño de lo que declara, o de otro formato, es un hallazgo.
- El favicon, el icono táctil de Apple, el icono SVG, la pestaña fijada de Safari y los mosaicos de Windows se juzgan cada uno según lo que la plataforma pide de verdad, como un PNG opaco de 180×180 para iOS.
- Una página que no enlaza ningún icono táctil de Apple se comprueba contra la ruta que iOS pide de todos modos.

### Peso de imágenes medido, no estimado

- Cada imagen que carga el sitio se recodifica una vez, y se informan los bytes que ahorrarían AVIF, WebP o una codificación más ajustada de su propio formato.
- Cada imagen pesada es un solo hallazgo con las páginas que la usan, en todo el sitio y no en una muestra de páginas.
- Se señalan por plantilla las imágenes que envían muchos más píxeles de los que muestran, o que no tienen ancho y alto para reservar su espacio.
- Las mediciones se guardan en caché con la imagen, así que una nueva ejecución solo mide lo que cambió.
- Las fuentes, hojas de estilo y scripts se pesan igual: fuentes que no son WOFF2, tipografías que ocultan el texto mientras cargan y los bytes que ahorraría la minificación.

### El sitio medido como un todo

- El peso, las peticiones, los tiempos y el carbono de cada página se suman en cifras de todo el sitio: mediana, percentil 95, extremos y totales, aunque ninguna página supere un presupuesto.
- Se señala la página mucho más lenta o pesada que el resto, o servida de otra forma que casi todas las demás, y el mismo rastreo siempre da la misma respuesta.
- Todos los datos de cada página se exportan a una hoja de cálculo, sin volver a rastrear.

### Enlaces rotos, dentro y fuera del sitio

- Un enlace que no lleva a ninguna parte, a este sitio o a otro, es un solo hallazgo con la lista de páginas que lo contienen.
- Los enlaces a otros sitios se comprueban una vez por ejecución y se recuerdan durante una semana, así que una nueva ejecución no les envía nada.
- Un sitio que solo pide al verificador que vaya más despacio no se informa como roto.
- Los feeds que una página anuncia en su cabecera también se rastrean y comprueban, aunque ningún enlace apunte a ellos.
- Se detectan los enlaces internos marcados nofollow, los enlaces a contenido pagado o de usuarios pueden sujetarse a una política rel que declara el propietario, y se informa de un perfil que el sitio reclama como propio pero que no enlaza de vuelta, como exige la verificación de Mastodon.

### Autenticación del correo de cada dominio que recorre

- Detecta por sí solo si un dominio recibe o envía correo, y al que no hace ninguna de las dos cosas le mantiene las revisiones sin correo, así que nadie tiene que decir de qué tipo es.
- Recorre SPF a través de cada include igual que los receptores, así que un registro que falla en silencio por demasiadas consultas o un include que no existe sale a la luz antes de que el correo rebote.
- Revisa DMARC, DKIM y MX en busca de los fallos que castigan los receptores: varias políticas, direcciones de informes que los rechazan, claves cortas, claves que siguen en prueba y servidores de correo detrás de un CNAME.
- Lee MTA-STS, los informes de TLS y BIMI de principio a fin, así que detecta una política que deja fuera a un servidor de correo o un logotipo que ningún cliente de correo va a mostrar.
- DANE y una prueba STARTTLS en vivo de cada servidor de correo están disponibles cuando los activas.

### Cada origen comprobado una vez, más allá de sus páginas

- Se pide a propósito una página inexistente, así que un falso 404, o una página de error que filtra una traza de pila o la versión del servidor, es un hallazgo.
- Cada entrada — http o https, con o sin `www.`, en la raíz o en una página interior — debe llegar a un único origen canónico con una redirección permanente que conserve la ruta, y la página de inicio no debe redirigir a los visitantes según su idioma.
- Se informa de los archivos de política entre dominios que permiten a cualquier otro sitio leer páginas con la sesión del visitante.
- Los plugins añaden sus propias comprobaciones por origen o por host; sus resultados se reutilizan entre ejecuciones y sus peticiones nunca salen del host que comprueban.

### Datos estructurados y marcado revisados en cada página

- Se informa de los datos estructurados en JSON-LD, Microdata o RDFa que no se pueden leer, carecen de lo que exige su resultado enriquecido, contradicen a la página o al resto del sitio, usan términos retirados de schema.org o fechas mal escritas o contradictorias, o cuyas migas de pan llevan a páginas inexistentes o movidas.
- El manifiesto de la aplicación web se revisa en lo que hace falta para instalar el sitio: un nombre, una página de inicio, un modo de visualización e iconos de los tamaños que piden los teléfonos.
- Los textos de enlace vagos como «haz clic aquí» se buscan en el idioma de la propia página, y un idioma sin lista revisada se omite en vez de juzgarse en inglés.

### Problemas de velocidad encontrados sin navegador

- Cada respuesta de texto debe ir comprimida con Brotli, Zstandard o gzip, y cada página debe poder guardarse en caché, revalidarse y entrar en la caché de ida y vuelta.
- Se informa de un servidor que sigue en HTTP/1.1, de uno que no anuncia HTTP/3 y de un certificado cuya clave RSA hace cada negociación más grande de lo que haría una clave EC.
- Los scripts y hojas de estilo que bloquean el primer renderizado, una primera imagen con carga diferida y las imágenes sin tamaño que les reserve su hueco se encuentran en el HTML de cada página.
- Las páginas renderizadas obtienen las puntuaciones de rendimiento, accesibilidad, buenas prácticas y SEO de Lighthouse y LCP, CLS, TBT y FCP de laboratorio, en una muestra de cada plantilla.

### Privacidad antes del consentimiento

- Se informa de las cookies de terceros y de seguimiento que se crean en la primera carga, antes de que el visitante toque nada, y también del almacenamiento web escrito de la misma forma.
- Las cookies que escriben los scripts se juzgan con las mismas exigencias que las que crea el servidor.
- Los proveedores de analítica y publicidad que carga el sitio se reúnen en un inventario, para saber qué debe nombrar la política de privacidad.
- Se informa de una página sin enlace a su política de privacidad.

### Sitios en cualquier red, rastreados con cortesía

- Los servicios onion y los sitios I2P se auditan con un solo ajuste, a través del proxy local de Tor o I2P, al ritmo y con los tiempos de espera que esas redes necesitan.
- Cada petición del rastreo simple y del rastreo con navegador puede pasar por un proxy HTTP, HTTPS o SOCKS, incluidos los proxies SOCKS que resuelven ellos mismos los nombres de host.
- Un servidor que responde «demasiadas peticiones» o «no disponible» se reintenta con espera creciente respetando su `Retry-After`, y un límite de peticiones por minuto mantiene el rastreo dentro de lo que el sitio tolera.
- robots.txt se obedece salvo que indiques lo contrario.

### Informes para personas, canalizaciones y agentes de código

- Los hallazgos salen en texto, JSON, SARIF, Checkstyle, CSV o un informe HTML, y un rastreo guardado se vuelve a formatear sin pedir de nuevo el sitio.
- Cada hallazgo puede decir cómo corregirlo en el sitio auditado, con el registro, la cabecera o la etiqueta exactos y los nombres del propio sitio ya puestos, y el análisis de código muestra la misma guía junto a cada alerta.
- El formato agent convierte los hallazgos en instrucciones de corrección para un agente de código, ordenadas por severidad y por cuántas páginas arregla cada corrección.
- Una acción de CI audita un sitio en cada push, hace fallar el trabajo en la severidad que elijas, sube el SARIF al análisis de código y guarda el rastreo en caché, así que volver a auditar un sitio sin cambios cuesta casi nada.
- Los códigos de salida distinguen los hallazgos de una configuración errónea y de un sitio que no se pudo alcanzar, para que una canalización sepa qué falló.

### Dependencias de página descargadas una sola vez

- Los scripts, hojas de estilo, imágenes y marcos que cargan las páginas se descargan una vez por ejecución, sea cual sea su origen.
- Una dependencia rota o insegura es un solo hallazgo con la lista de páginas que la usan, no un hallazgo por página.
- Se informan los scripts de otro origen sin hash de integridad y los recursos HTTP sin cifrar en páginas HTTPS.
- El manifiesto de la aplicación web se descarga y se juzga como cualquier otra dependencia.

### robots.txt leído como lo leen los rastreadores

- Se informa de un robots.txt que impide a todos los rastreadores entrar en todo el sitio, porque saca el sitio de los resultados de búsqueda.
- Los rastreadores de IA que nombra se listan por propósito —entrenamiento, búsqueda o petición de un usuario—, con los que bloquea y los nombres que ningún proveedor usa ya.
- Se informan las Content Signals que dicen algo distinto de sí o no a la búsqueda, a la entrada de IA o al entrenamiento de IA.

### Más de 500 reglas, y las nuevas escritas como datos

- Una regla es una ruta de hecho más un JSON Schema, así que una comprobación nueva no requiere código.
- Los preajustes incluidos cubren buscadores, cabeceras de seguridad, TLS, DNS, cookies, rendimiento, accesibilidad, privacidad, sostenibilidad, enlaces, redirecciones, sitemaps, robots.txt, archivos well-known y archivos para agentes de IA.
- Cada grupo de URL ejecuta sus propios conjuntos de reglas, y la severidad de cualquier regla se puede cambiar o desactivar desde la línea de órdenes, el entorno o el projectfile.
- axe-core, html-validate y htmlhint se ejecutan dentro del mismo rastreo, cada una de sus comprobaciones es una regla que se puede ajustar o desactivar como cualquier otra, y las puntuaciones de Lighthouse se suman en las páginas renderizadas.
- Los complementos añaden sus propios hechos, reglas, preajustes, formatos de informe y fuentes de URL junto a los incluidos, y una simple lista de URL se puede auditar por sí sola.

### Visibilidad en buscadores revisada en todo el sitio

- Títulos, descripciones, encabezados, enlaces canónicos y etiquetas Open Graph se revisan en cada página, y un título o una descripción que comparten varias páginas es un solo hallazgo que las lista todas.
- El sitemap se contrasta con el rastreo: se informa de las páginas que lista y a las que ninguna página enlaza, de las que omite y de las listadas marcadas como noindex.
- En el grafo de enlaces de todo el sitio se encuentran las páginas a más de tres clics de la inicial, las que no enlazan a ninguna parte y las que solo enlaza otra página.
- Las versiones de idioma deben nombrarse entre sí y responder, y el idioma declarado de cada página se compara con el idioma en que están escritos su título y su descripción.
- Una copia de pruebas o de desarrollo abierta a la indexación se detecta antes de que la encuentren los buscadores.

### Cabeceras de seguridad evaluadas, no solo detectadas

- Content-Security-Policy se lee directiva por directiva, desde la cabecera o un `<meta>`: los scripts en línea sin nonce ni hash, `eval`, los scripts desde cualquier host y la falta de `object-src`, `base-uri`, `frame-ancestors` o Trusted Types son cada uno un hallazgo propio.
- HSTS debe durar lo suficiente y cubrir los subdominios, y las respuestas no deben poder ser olfateadas, enmarcadas por otros sitios ni filtrar URL completas por el referente.
- El aislamiento entre orígenes, Permissions-Policy y los puntos de notificación se revisan en cada página, no solo en la portada.
- Se informa de una cabecera X-XSS-Protection que aún activa el filtro retirado, porque ese filtro también se puede aprovechar.
- Una cabecera que rompe su propia gramática, como un max-age de HSTS que no es un número o una directiva de Cache-Control que ninguna caché conoce, es un solo hallazgo que nombra el fallo, en lugar de aprobar por estar presente o de fallar en cada comprobación que la lee.

### Servidor de análisis

- La misma imagen funciona como API HTTP con cola de trabajos y como página web donde cualquiera escribe un dominio y lee el informe en inglés, español o ucraniano, con o sin JavaScript.
- Cada análisis informa de su progreso mientras se ejecuta, su informe se descarga en todos los formatos que produce la línea de órdenes, y un sitio puede mostrar su última calificación como una insignia que enlaza al informe.
- Quien administra la instancia define políticas por dominio: vetar un dominio de nivel superior, limitar la frecuencia con que se analiza un host, acotar páginas y tiempo, y elegir qué reglas pueden ejecutarse. Repetir una petición dentro de una ventana fijada devuelve el análisis ya hecho, y cada cliente tiene su propio límite.
- Las políticas se recargan desde un archivo montado sin reiniciar.
- Un análisis no puede dirigirse a direcciones de bucle local, privadas ni de metadatos de la nube.

### Rastrear una vez, analizar muchas

- Un rastreo se puede guardar en disco y analizar de nuevo con reglas o grupos cambiados, sin acceso a la red.
- Un rastreo interrumpido se reanuda donde se detuvo.
- Un rastreo repetido solo pregunta al sitio si cada página, script y sitemap cambió, y no vuelve a descargar ni a analizar lo que no cambió.
- Las descargas binarias se juzgan por sus cabeceras y nunca se descargan completas, así que un archivo comprimido o un vídeo enlazado no consume ancho de banda.
- Una copia de staging se audita como el sitio para el que está construida, así que sus enlaces y su sitemap que nombran la dirección de producción no se informan como errores.

### La huella de cada visita a una página

- El carbono que emite una visita a cada página se estima a partir de los bytes que transfieren la página y todo lo que carga, según el modelo Sustainable Web Design, y se informa de las páginas que superan el presupuesto.
- El carbon.txt del sitio debe existir, ser válido y estar al día, y las declaraciones que nombra deben ser accesibles.

### Configuración TLS analizada en casa

- Se listan todos los protocolos y conjuntos de cifrado que acepta un servidor, incluidos SSLv2, SSLv3, RC4 y los de exportación, que las bibliotecas TLS actuales ya no pueden ver.
- Los conjuntos rotos y débiles, la falta de secreto hacia adelante, los primos Diffie-Hellman cortos y la compresión de registros son hallazgos, y también los ataques que abren: POODLE, BEAST, SWEET32, FREAK, Logjam, DROWN y CRIME.
- Una cadena de certificados sin sus intermedios se detecta también en servidores que solo hablan TLS 1.3.
- Una regla propia como «nada de conjuntos CBC» son unas líneas de configuración, no código.
- No se consulta a ningún escáner externo ni se explota nada: al servidor solo se le pregunta qué negociaría, una vez por origen mientras el resultado siga vigente.

### Transporte comprobado por página, no por host

- El certificado, el protocolo TLS y la dirección remota se leen de la conexión que sirvió cada página, así que dos backends tras un mismo nombre se informan en lugar de quedar ocultos.
- Los certificados a punto de caducar, los certificados rechazados, las claves o firmas de certificado débiles y las versiones de TLS obsoletas son hallazgos.
- Los tiempos, las cadenas de redirección y los atributos de las cookies se registran para cada página, y los valores de las cookies nunca salen del rastreador.
- Se informa de una cookie que los navegadores rechazarían o acortarían sin avisar y de una precarga que una pista temprana promete y la página luego abandona.

### Lo que añade la CDN o el alojamiento, por separado

- Las páginas que una CDN o un alojamiento sirve en el sitio, como la página de protección de correo de Cloudflare, no se juzgan como propias del sitio, así que no bajan su nota.
- Los scripts que inyecta la CDN o el alojamiento se siguen comprobando, y sus hallazgos aparecen bajo el proveedor que los sirve.
- Una función activada en el panel de la CDN que cuesta algo a los visitantes, como direcciones de correo ocultas para quien no tiene JavaScript, se nombra junto con el ajuste que la desactiva.

### Los archivos que un sitio publica junto a sus páginas

- Se informa de un `security.txt` ausente o caducado, para que quien investiga la seguridad siempre tenga cómo contactarte.
- Un sitio con un campo de contraseña debe llevar `/.well-known/change-password` a algún sitio, para que los gestores de contraseñas lleven al usuario directamente al formulario correcto.
- Cualquier otro archivo conocido (señales de privacidad, metadatos de OpenID y OAuth, enlaces de aplicaciones, información de nodos del Fediverso, condiciones para rastreadores de IA) se comprueba solo si existe, así que publicar uno roto nunca pasa desapercibido.
- Los archivos para agentes de IA (`llms.txt`, tarjetas de agente, índices de MCP y de habilidades) se comprueban en su propio preset opcional, incluidos los enlaces de `llms.txt` que llevan a páginas rotas y si las páginas ofrecen una versión en Markdown.
- Una página inexistente servida como HTML cuenta como ausencia, así que un sitio que responde a cualquier URL no inunda el informe.

## Heredado de B19 / Ubuntu

### Caché APT persistente entre compilaciones

- Las cachés de paquetes e índices de APT sobreviven entre compilaciones mediante montajes de caché de BuildKit, con clave por serie de Ubuntu y arquitectura.
- Las compilaciones repetidas reutilizan los paquetes descargados en lugar de volver a descargarlos.
- Proxy opcional de caché APT en LAN, se activa con `M6E_APT_CACHE_HOST`.

### Gestión de procesos de servicio con enrutado de logs (b19-exec)

- Los procesos de larga duración (demonios, servidores) tienen stdout y stderr enrutados automáticamente a través del logger estructurado.
- Se hace seguimiento del PID del servicio para el reenvío de señales: Docker stop termina de forma elegante el proceso principal.
- Los niveles de log de los flujos stdout y stderr se configuran de forma independiente.
- El código de salida del servicio se captura y queda disponible para los hooks posteriores.

### Descargas de artefactos con caché y verificación de integridad (b19-fetch)

- Todas las descargas externas pasan por una caché de tres niveles: directorio local `.fetch/`, caché persistente de BuildKit y luego upstream vía aria2c con hasta 16 conexiones.
- Verificación SHA-512 opcional en cada nivel; un hash que no coincide provoca caída al siguiente nivel en lugar de fallo.
- El modo offgrid bloquea todas las descargas por completo, fallando rápido con un error claro si se produce un fallo de caché.
- Admite un proxy de near-cache para compilaciones solo-LAN que pasan por un proxy de caché.

### Ejecución de comandos temporizada con informe de fallos (b19-run)

- Cualquier comando puede envolverse para obtener medición automática del tiempo transcurrido e informe de éxito o fallo.
- La salida correcta solo es visible en niveles de verbosidad mayores; la salida de fallo siempre se muestra.
- En modo debug, la salida del comando se transmite en vivo en lugar de almacenarse en búfer.

### Inicialización de una sola vez (bootstrap.d)

- Las tareas de configuración únicas (migraciones de base de datos, creación del usuario administrador, init de directorios) se ejecutan solo en el primer arranque del contenedor.
- Idempotencia automática: los scripts completados no vuelven a ejecutarse jamás, ni siquiera entre reinicios del contenedor.
- Los scripts fallidos se reintentan en el siguiente arranque; los exitosos quedan bloqueados.
- El estado puede resetearse limpiando un volumen, lo que dispara un re-bootstrap completo.
- Las imágenes derivadas añaden sus propios scripts de init dejándolos caer en un directorio.

### Hooks de compilación modulares (build.d)

- Toda la lógica de compilación de la imagen vive en scripts de shell numerados en lugar de comandos `RUN` inline en el Dockerfile.
- Los hooks se organizan en fases `pre/on/post` y se autodescubren por el nombre de etapa pasado a `build-stage`.
- El ámbito reservado `always/{pre,post}` enmarca cada etapa, se llame como se llame, de modo que la configuración transversal se escribe una vez en lugar de por etapa.
- Los hooks heredables se propagan a las imágenes derivadas automáticamente vía superposición de capas de Docker: las derivadas obtienen gratis la lógica de compilación del padre.
- Los hooks no heredables se limpian tras su ejecución para evitar que se filtren en etapas posteriores.

### Detección automática del número de CPUs (NUMPROCS)

- Las CPUs disponibles se detectan automáticamente con la downward API de Kubernetes, cgroups v2 o `nproc` como respaldo.
- El recuento detectado está disponible como `NUMPROCS` durante toda la compilación y el runtime, y se usa para compilación paralela, renderizado de plantillas y ejecución de tests.
- Elimina los recuentos de jobs hardcodeados y garantiza un paralelismo consistente entre Docker, Kubernetes y CI.

### Gestión declarativa de dependencias (b19-deps)

- Los metadatos de dependencias externas (URL, versión, hash SHA-512) se guardan como archivos de texto plano, completamente separados de los scripts de compilación.
- Admite descargas específicas por arquitectura, series multiversión y rutas de componentes anidadas.
- Las dependencias se autodescubren al parsear el Makefile: añade archivos al directorio correcto y la compilación los recoge sin declaraciones manuales.
- `make fetch` predescarga todo para compilaciones offline; los cambios de versión disparan un re-fetch y una actualización de hashes automáticos.

### Sistema de arranque conectable (entrypoint.d)

- Cada arranque de contenedor pasa por una secuencia de hooks numerados: configuración de señales, carga de secretos, detección de CPU, validación de puertos, renderizado de plantillas, bootstrap y arranque del servicio.
- Los comandos ad hoc (`docker run img command`) saltan automáticamente parte de la cadena de arranque y se ejecutan directamente.
- Tanto los hooks individuales como el entrypoint completo pueden omitirse en runtime mediante variables de entorno, sin reconstruir la imagen.
- Las imágenes derivadas sobrescriben un único hook (slot 5000) para lanzar su servicio; todo lo demás se hereda.

### Conmutadores de funcionalidades para todos los subsistemas

- Cada subsistema mayor (entrypoint, healthchecks, bootstrap, tests, secrets, validación de puertos, i18n, shell hooks) puede desactivarse en runtime mediante variables de entorno.
- Los hooks individuales del entrypoint, del bootstrap y de las comprobaciones de salud pueden omitirse por nombre sin desactivar el subsistema entero.
- No hace falta reconstruir la imagen: los conmutadores son solo de runtime.

### Monitorización de estado integrada (healthcheck.d)

- Healthcheck nativo de Docker heredado por todas las imágenes derivadas sin configuración extra.
- Las comprobaciones de salida son opcionales: un contenedor que nunca llega a internet no lleva ninguna comprobación que un tercero pueda hacer fallar, mientras que uno cuyo trabajo es internet se marca como no disponible en cuanto el exterior desaparece.
- Funciona igual sin conexión que en línea: las comprobaciones de salida se retiran automáticamente en modo offgrid.
- Añadir una comprobación es dejar caer un script en un directorio, no escribir configuración de Docker.
- Las comprobaciones pesadas o con límite de peticiones se ejecutan cada hora en segundo plano, de modo que un escaneo lento nunca agota el tiempo del healthcheck ni consume un límite de peticiones.

Consulte [use-healthcheck.d](../how-to/use-healthcheck.d.md) para la lista de comprobaciones, la numeración de slots y la configuración.

### Salida de shell multilingüe (b19-i18n)

- Todos los mensajes de log y la salida de scripts orientados al usuario son traducibles vía GNU gettext.
- Trae de fábrica inglés, español (`es_CL`) y ucraniano (`uk_UA`).
- Las imágenes derivadas heredan automáticamente todas las traducciones del padre; solo las cadenas nuevas o sobrescritas necesitan traducción.
- Las traducciones se compilan en tiempo de compilación sin coste en runtime.

### Seguimiento del linaje de la imagen

- Cada imagen registra sus metadatos de compilación (namespace, proyecto, versión, imagen base) en un archivo de linaje durante la compilación.
- Las imágenes derivadas encadenan el linaje de su padre, produciendo una cadena de procedencia completa desde la base hasta la actual.
- Toda la cadena de linaje se registra al arrancar (verbosidad debug) y puede leerse del archivo en cualquier momento, lo que facilita rastrear a partir de qué se construyó un contenedor en ejecución.

### Logging estructurado con filtro por nivel (b19-log)

- Toda la salida del contenedor pasa por un logger con niveles y cuatro umbrales: error, warn, info, debug.
- Los mensajes por debajo de la verbosidad configurada se descartan silenciosamente, manteniendo limpios los logs de producción.
- Los colores autodetectan el soporte del terminal y respetan `NO_COLOR=1`.
- Encauzable: la salida de comandos puede enrutarse a través del logger para aplicar filtrado por nivel y tags.

### Contenedor sin privilegios de root por defecto

- El contenedor se ejecuta como usuario sin privilegios de root (`ubuntu`, UID/GID 1000) con todos los archivos de runtime en propiedad de ese usuario.
- Una compilación en dos etapas separa la instalación del sistema a nivel root de la configuración del runtime a nivel de usuario.
- La identidad del usuario es configurable en tiempo de compilación, y un arranque opcional como root la reasigna al usuario del host para que los montajes bind conserven su propietario.

### Soporte de compilación y runtime aislados de internet (air-gapped/offline)

- Una única variable de entorno (`B19_OFFGRID_MODE=Y`) corta todo acceso a internet en tiempo de compilación y en runtime.
- En compilación: se bloquean las descargas, se saltan las actualizaciones de APT y se saltan los keyscans de SSH. Todos los artefactos deben provenir de los niveles de caché.
- En runtime: las comprobaciones de estado de red se saltan automáticamente con resultado saludable, así los contenedores permanecen en verde en redes aisladas.
- Las listas de paquetes APT pueden capturarse como snapshot e inyectarse para compilaciones de imagen totalmente offline.
- Los servicios de LAN (proxies de caché, registros) siguen siendo accesibles: offgrid bloquea internet, no toda la red.

### Inyección de overlays en runtime

- Se pueden inyectar archivos de configuración o datos al arrancar el contenedor estableciendo en `B19_OVERLAY` el nombre de un directorio.
- El contenido del overlay se copia recursivamente a la raíz del contenedor, sobrescribiendo los archivos existentes; no hace falta reconstruir la imagen.
- Se omite en modo inmutable, impidiendo la modificación en runtime de imágenes bloqueadas para producción.

### Imagen base reproducible (fijada por digest)

- La imagen base de Ubuntu está fijada por digest SHA-256, no por tag, lo que garantiza compilaciones deterministas.
- Admite varias series de Ubuntu (resolute, noble, jammy) seleccionables en tiempo de compilación.
- Los mirrors de APT son configurables por arquitectura para mirrors de LAN o entornos aislados.

### Validación de puertos

- Todas las variables de entorno `*PORT*` se validan al arrancar contra la lista de puertos prohibidos de WHATWG y contra los puertos privilegiados (\<1024).
- Detecta temprano configuraciones erróneas como `HTTP_PORT=22`, antes de que el servicio falle en silencio.
- Puede desactivarse en runtime sin reconstruir la imagen.

### Familia unificada de runners del ciclo de vida

- Ocho runners de hooks numerados cubren el ciclo de vida completo del contenedor: arranque, healthchecks, tests, bootstrap, hooks de compilación, benchmarks, reports y sesiones de shell.
- Todos los runners comparten el mismo patrón: deja caer un script numerado en un directorio y se autodescubre y ejecuta.
- Los scripts de distintas capas de imagen se mezclan: los hooks upstream y los derivados coexisten sin conflicto.
- Cada runner tiene semántica de fallo a medida: abortar ante error (entrypoint, bootstrap), continuar y contar fallos (healthchecks, tests), tener siempre éxito (reports).

### Autocarga de secretos de Docker (secrets)

- Los archivos de secretos de Docker se autodescubren y convierten en variables de entorno al arrancar.
- Los nombres de archivo en notación de puntos se mapean a variables de entorno en mayúsculas (`b19.npm.registry_host` se convierte en `B19_NPM_REGISTRY_HOST`).
- Los secretos requeridos pueden declararse por nombre; el contenedor se niega a arrancar si falta alguno.
- Las variables de entorno existentes tienen precedencia sobre los valores derivados de secretos.
- Los secretos también están disponibles en sesiones de shell interactivas y en healthchecks.
- Los secretos no UTF-8/binarios (claves, blobs DER, tarballs comprimidos con gzip) **no** se exportan como variables de entorno: Bash los trunca en el primer NUL y los bytes sueltos hacen fallar a cualquier herramienta que lea el entorno como UTF-8 (p. ej., `minijinja --env`, usado para plantillar configuraciones). Permanecen en disco en `/run/secrets/<name>` para lecturas basadas en archivo — que, de todos modos, es la única forma correcta de consumir un secreto binario.

### Hooks de shell interactivo (shell.d)

- Las sesiones `docker exec bash` cargan automáticamente los secretos de Docker y cualquier hook personalizado añadido por las imágenes derivadas.
- Los hooks se mezclan vía superposición de capas de Docker, así que la configuración de shell heredada y la específica del proyecto coexisten.

### Gestión elegante de señales

- El PID 1 es `tini -g`, que recoge los procesos zombi y reenvía señales a todo el grupo de procesos.
- Un conjunto configurable de señales Unix (TERM, INT, HUP, USR1, USR2, etc.) se captura y reenvía al proceso principal del servicio.
- `docker stop` termina limpiamente el servicio sin procesos huérfanos ni pérdida de señales.

### Plantillas de configuración Jinja2 (minijinja-cli)

- Renderizado de plantillas compatible con Jinja2 tanto en tiempo de compilación como al arrancar el contenedor.
- Deja caer un archivo `.j2` en cualquier parte del directorio de la aplicación; se descubre en tiempo de compilación y se renderiza en cada arranque con todas las variables de entorno disponibles.
- El renderizado en runtime es paralelo y automático: las imágenes derivadas lo obtienen sin configuración alguna.
- El modo inmutable (`B19_IMMUTABLE=Y`) congela el sistema de archivos en el estado de compilación, saltándose todo renderizado en runtime.

### Framework de tests integrado (test.d)

- Los tests se ejecutan dentro del contenedor en marcha vía `make test` o `docker exec`.
- Espera automáticamente a que pasen los healthchecks antes de ejecutar.
- Sin dependencia de ningún framework de tests: los tests son scripts de shell simples con códigos de salida, y una comprobación fallida indica qué esperaba y qué encontró.
- Admite plantillas Jinja2 en los tests, útil para afirmar en runtime valores fijados en compilación.
- Continúa ante fallos e informa del recuento total; nunca oculta resultados parciales.

### Nada se cuelga para siempre

- Cada paso de arranque, prueba y comando puntual tiene un límite de tiempo, así que una herramienta bloqueada falla de forma visible en lugar de detener un despliegue o una ejecución de CI.
- Las descargas estancadas se abortan, mientras que las lentas de cualquier tamaño se completan.
- Una llamada inestable puede reintentarse con espera progresiva con una sola opción, sin escribir un bucle a mano.
- Un reinicio opcional convierte un servicio atascado en estado no saludable en un contenedor que la política de reinicio recupera.

Consulta [use-timeouts](../how-to/use-timeouts.md) para las opciones, los valores por defecto y cómo cambiarlos.

### Herramientas de utilidad preinstaladas

- `mold` como enlazador por defecto (con opción de desactivarlo).
- `fd` para búsqueda de archivos, `minijinja-cli` para renderizado de plantillas.
- `aria2c` para descargas multiconexión, `tini` como PID 1 para recoger zombis.
- Herramientas de compresión paralela: `pbzip2`, `pigz`, `pixz`.
- Herramientas gettext para la compilación de i18n, `cURL` para operaciones de red.

### Rutas XDG Base Directory

- Las rutas XDG estándar (`XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`) se establecen bajo el directorio home de la aplicación.
- Todas las rutas son escribibles por el usuario sin privilegios de root, sin escalada de privilegios.
<!-- textlint-enable -->
