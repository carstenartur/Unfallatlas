#!/bin/sh


# 032305 Hannover

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



