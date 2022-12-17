# Unfallatlas
Script zum Konvertieren von Daten
Benötigt curl, unzip, head und awk

Unfallatlas auf

https://unfallatlas.statistikportal.de/

Verwendet Daten von 
https://unfallatlas.statistikportal.de/_opendata2022.html

Beispiel

```
OBJECTID_1;ULAND;UREGBEZ;UKREIS;UGEMEINDE;UJAHR;UMONAT;USTUNDE;UWOCHENTAG;UKATEGORIE;UART;UTYP1;ULICHTVERH;IstRad;IstPKW;IstFuss;IstKrad;IstGkfz;IstSonstig;STRZUSTAND;LINREFX;LINREFY;XGCSWGS84;YGCSWGS84
1;01;0;03;000;2018;01;08;5;2;0;7;0;1;0;0;0;0;0;0;612054,341999999950000;5969634,006000000100000;10,703950299000041;53,863081147000059
2;01;0;62;020;2018;01;15;6;3;5;2;0;0;1;0;0;0;0;1;592301,984999999990000;5938800,026999999800000;10,394496814000036;53,589905976000068
3;01;0;56;015;2018;01;19;4;3;2;6;2;0;1;0;0;0;0;1;547114,933199999970000;5955266,091099999800000;9,714396363000049;53,743906875000050
...
```

Konvertiert in 

```
WKT,Name,OBJECTID
"POINT (9.613538860000062 52.392190656000082)",Fahrrad 8541, Licht: 2 Strasse: 0,8541
"POINT (9.963940036000054 52.316034063000075)",Fahrrad 8618, Licht: 1 Strasse: 1,8618
"POINT (9.697102799000049 52.341540381000073)",Fahrrad 8658, Licht: 2 Strasse: 1,8658
"POINT (9.754920941000023 52.436212711000053)",Fahrrad 8757, Licht: 0 Strasse: 0,8757
...
```

Dadurch kann man die Daten dann in google maps importieren

Wegen der Datenmengenbegrenzung beim Import in google maps werden nur die ersten 2000 Zeilen importiert.

![image](https://user-images.githubusercontent.com/3164220/208238452-d67a3db4-b15e-40ce-994b-34ab86ae9813.png)

![image](https://user-images.githubusercontent.com/3164220/208238510-32f58332-969e-4fff-9f89-c22ee4198048.png)



https://www.google.com/maps/d/viewer?hl=de&hl=de&mid=141aHGXdO_4ZUzENVbB2fFYjxQDgcpac&ll=52.37912703502791%2C9.73286511695368&z=15

