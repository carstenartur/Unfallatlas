#!/bin/sh


# 032305 Hannover

#Bundesland
#01 = Schleswig-Holstein (Daten ab 2016)
#02 = Hamburg (Daten ab 2016)
#03 = Niedersachsen (Daten ab 2017)
#04 = Bremen (Daten ab 2016)
#05 = Nordrhein-Westfalen (Daten ab 2019)
#06 = Hessen (Daten ab 2016)
#07 = Rheinland-Pfalz (Daten ab 2017)
#08 = Baden-Württemberg (Daten ab 2016)
#09 = Bayern (Daten ab 2016)
#10 = Saarland (Daten ab 2017)
#11 = Berlin (Daten ab 2018)
#12 = Brandenburg (Daten ab 2017)
#13 = Mecklenburg-Vorpommern (Daten ab 2020)
#14 = Sachsen (Daten ab 2016)
#15 = Sachsen-Anhalt (Daten ab 2017)
#16 = Thüringen (Daten ab 2019)

#Nummer Amtsgerichtsbezirk
#011112 Flensburg
#011115 Husum
#011118 Niebüll
#011119 Schleswig
#011312 Elmshorn
#011315 Itzehoe
#011319 Meldorf
#011321 Pinneberg
#011512 Bad Segeberg
#011514 Eckernförde
#011517 Kiel
#011519 Neumünster
#011522 Plön
#011524 Rendsburg
#011526 Norderstedt
#011711 Ahrensburg
#011716 Eutin
#011721 Lübeck
#011724 Oldenburg
#011725 Ratzeburg
#011726 Reinbek
#011728 Schwarzenbek
#021100 Hamburg
#031101 Bad Gandersheim
#031103 Braunschweig
#031104 Goslar
#031105 Helmstedt
#031108 Salzgitter
#031111 Seesen
#031115 Wolfenbüttel
#031116 Clausthal-Zellerfeld
#031117 Wolfsburg
#031202 Duderstadt
#031203 Einbek
#031204 Göttingen
#031205 Hann. Münden
#031206 Herzberg am Harz
#031208 Northeim
#031209 Osterode am Harz
#032101 Bückeburg
#032104 Rinteln
#032106 Stadthagen
#032303 Burgwedel
#032304 Hameln
#032305 Hannover
#032306 Neustadt am Rübenb.
#032307 Springe
#032308 Wennigsen (Deister)
#032401 Alfeld (Leine)
#032403 Burgdorf
#032404 Elze
#032407 Gifhorn
#032408 Hildesheim
#032409 Holzminden
#032410 Lehrte
#032411 Peine
#032503 Celle
#032504 Dannenberg (Elbe)
#032507 Lüneburg
#032509 Soltau
#032510 Uelzen
#032511 Winsen (Luhe)
#032601 Bremervörde
#032602 Buxtehude
#032603 Cuxhaven
#032608 Langen
#032611 Ottendorf
#032612 Stade
#032613 Tostedt
#032614 Zeven
#032701 Achim
#032705 Diepholz
#032708 Nienburg (Weser)
#032709 Osterholz-Scharmbeck
#032710 Rotenburg (Wümme)
#032711 Stolzenau
#032712 Sulingen
#032713 Syke
#032715 Verden
#032716 Walsrode
#033101 Aurich
#033102 Emden
#033104 Leer
#033105 Norden
#033107 Wittmund
#033201 Brake
#033202 Cloppenburg
#033204 Delmenhorst
#033207 Jever
#033209 Nordenham
#033210 Oldenburg (Oldenb.)
#033211 Varel
#033212 Vechta
#033213 Westerstede
#033214 Wildeshausen
#033215 Wilhelmshaven
#033302 Bersenbrück
#033307 Bad Iburg
#033308 Lingen
#033310 Meppen
#033312 Nordhorn
#033313 Osnabrück
#033314 Papenburg

# weitere Amtsgerichtsbezirke bitte in 
# https://www.destatis.de/DE/Themen/Laender-Regionen/Regionales/Gemeindeverzeichnis/Administrativ/beschreibung-gebietseinheiten.pdf?__blob=publicationFile
# nachschlagen


curl  -o 2018.zip https://www.opengeodata.nrw.de/produkte/transport_verkehr/unfallatlas/Unfallorte2018_EPSG25832_CSV.zip
unzip -o 2018.zip
awk 'BEGIN{FS=";";print "WKT,Name,OBJECTID\r"} {if (NR!=1 && $2 == 03 && $3 == 2 && $4 == 41 && $14 == 1 ) {gsub(/\r/,"",$24);gsub(/,/,".",$23);gsub(/,/,".",$24);print  "\"POINT (" $23 " " $24 ")\",Fahrrad " $1 ", Licht: " $13 " Strasse: " $20 "," $1 "\r"}}' <csv/Unfallorte2018_LinRef.txt  |head -1999 >output2018.csv

curl  -o 2019.zip https://www.opengeodata.nrw.de/produkte/transport_verkehr/unfallatlas/Unfallorte2019_EPSG25832_CSV.zip
unzip -o 2019.zip
awk 'BEGIN{FS=";";print "WKT,Name,OBJECTID\r"} {if (NR!=1 && $2 == 3 && $3 == 2 && $4 == 41 && $14 == 1 ) {gsub(/\r/,"",$24);gsub(/,/,".",$22);gsub(/,/,".",$23);print  "\"POINT (" $22 " " $23 ")\",Fahrrad " $1 ", Licht: " $13 " Strasse: " $24 "," $1 "\r"}}' <csv/Unfallorte2019_LinRef.txt  |head -1999 >output2019.csv

curl  -o 2020.zip https://www.opengeodata.nrw.de/produkte/transport_verkehr/unfallatlas/Unfallorte2020_EPSG25832_CSV.zip
unzip -o 2020.zip
awk 'BEGIN{FS=";";print "WKT,Name,OBJECTID\r"} {if (NR!=1 && $3 == 3 && $4 == 2 && $5 == 41 && $16 == 1 ) {gsub(/\r/,"",$25);gsub(/,/,".",$23);gsub(/,/,".",$24);print  "\"POINT (" $23 " " $24 ")\",Fahrrad " $1 ", Licht: " $14 " Strasse: " $15 "," $1 "\r"}}' <csv/Unfallorte2020_LinRef.csv  |head -1999 >output2020.csv

curl  -o 2021.zip https://www.opengeodata.nrw.de/produkte/transport_verkehr/unfallatlas/Unfallorte2021_EPSG25832_CSV.zip
unzip -o 2021.zip
awk 'BEGIN{FS=";";print "WKT,Name,OBJECTID\r"} {if (NR!=1 && $3 == 3 && $4 == 2 && $5 == 41 && $16 == 1 ) {gsub(/\r/,"",$25);gsub(/,/,".",$24);gsub(/,/,".",$25);print  "\"POINT (" $24 " " $25 ")\",Fahrrad " $1 ", Licht: " $14 " Strasse: " $15 "," $1 "\r"}}' <Unfallorte2021_EPSG25832_CSV.csv  |head -1999 >output2021.csv



