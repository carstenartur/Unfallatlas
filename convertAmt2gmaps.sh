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



